/**
 * Object-creation helpers and right-click context menus (ground/track/building/clouds/overlay).
 *
 * Extracted from CustomSupport.js as a mixin. Methods are merged into
 * CCustomManager.prototype so `this` references the CCustomManager instance.
 */
import {
    addGUIFolder,
    FileManager,
    getEffectiveUserID,
    GlobalDateTimeNode,
    Globals,
    guiMenus,
    guiShowHideViews,
    infoDiv,
    NodeFactory,
    NodeMan,
    setNewSitchObject,
    setRenderOne,
    setSitchEstablished,
    Sit,
    Synth3DManager,
    TrackManager,
    UndoManager,
    Units,
    withTestUser
} from "./Globals";
import {isKeyHeld, toggler} from "./KeyBoardHandler";
import {ECEFToLLAVD_radii, LLAToECEF} from "./LLA-ECEF-ENU";
import {par} from "./par";
import {makeCreateObjectUndoAction} from "./undoCreateObject";
import {GlobalScene} from "./LocalFrame";
import {refreshLabelsAfterLoading} from "./nodes/CNodeLabels3D";
import {assert} from "./assert";
import {getShortURL} from "./urlUtils";
import {CNode3DObject, ModelAliases} from "./nodes/CNode3DObject";
import {CNodePositionLLA} from "./nodes/CNodePositionLLA";
import {UpdateHUD} from "./JetStuff";
import {degrees, getDateTimeFilename} from "./utils";
import {ViewMan} from "./CViewManager";
import {EventManager} from "./CEventManager";
import {isAdmin, isSecureBuild, SITREC_APP, SITREC_SERVER} from "./configUtils";
import {CNodeDisplayTrack} from "./nodes/CNodeDisplayTrack";
import {DebugArrowAB, elevationAtLL} from "./threeExt";
import {FeatureManager} from "./CFeatureManager";
import {CNodeTrackGUI} from "./nodes/CNodeControllerTrackGUI";
import {forceUpdateUIText} from "./nodes/CNodeViewUI";
import {configParams} from "./runtimeConfig";
import {showError} from "./showError";
import {showPostLoadFilterDialog} from "./TrackFilterDialog";
import {textSitchToObject} from "./RegisterSitches";
import {waitForExportFrameSettled} from "./ExportFrameSettler";
import {nextSequentialObjectName, parseObjectInput as parseObjectInputUtil} from "./utils/parseObjectInput";
import {initializeSettings, SettingsSaver} from "./SettingsManager";
import {CNodeCurveEditor2} from "./nodes/CNodeCurveEdit2";
import {CNodeViewDAG} from "./nodes/CNodeViewDAG";
import {CNodeNotes} from "./nodes/CNodeNotes";
import {createCustomModalWithCopy, saveFilePrompted, saveFileToDirectory, saveFileToHandle} from "./FileUtils";
import {deserializeMotionAnalysis, serializeMotionAnalysis} from "./CMotionAnalysisUI";
import {deserializeAutoTracking, serializeAutoTracking} from "./CObjectTracking";
import {getCursorPositionFromTopView} from "./mouseMoveView";
import {addMenuToLeftSidebar, addMenuToRightSidebar, isInLeftSidebar, isInRightSidebar} from "./PageStructure";
import {CNodeControllerCelestial} from "./nodes/CNodeControllerVarious";
import {CNodeAutoTrackLOS} from "./nodes/CNodeAutoTrackLOS";
import {CNodeVideoInfoUI} from "./nodes/CNodeVideoInfoUI";
import {CNodeOSDDataSeriesController} from "./nodes/CNodeOSDDataSeriesController";
import {CNodeGUIValue} from "./nodes/CNodeGUIValue";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {collectActiveTrackSourceFileIDs, shouldSerializeLoadedFileEntry} from "./trackSourceUtils";
import {encodeShareParam, resolveURLForFetch, toShareableCustomValue} from "./SitrecObjectResolver";
import {getEnvBool} from "./envUtils";
import {CNodeOrbitTrack} from "./nodes/CNodeOrbitTrack";
import {CNodeTrackSwitch} from "./nodes/CNodeTrackSwitch";
import {getNearbyWeatherBalloons, importSoundingDialog} from "./SondeFetch";
import {WIND_SOURCES, windSourceLabelsToKeys, windSourceByKey} from "./nodes/WindSources";
import {getCurrentLanguage, setLanguage, SUPPORTED_LANGUAGE_OPTIONS, t} from "./i18n";
import {CNodeSAPage} from "./nodes/CNodeSAPage";
import {
    gimbalStepAirTrack,
    gimbalStepAirTrackDisplay,
    gimbalStepClouds,
    gimbalStepCommonViews,
    gimbalStepCore,
    gimbalStepFleet,
    gimbalStepGraphs,
    gimbalStepSAHAFU,
    gimbalStepTargetModel,
    gimbalStepTrackLOSNodes,
    gimbalStepTraverse,
} from "./GimbalCustomSetup";
import {Color} from "three";

export const menuMethods = {
    /**
     * Parse flexible object input string for coordinates and name
     * Supports formats like:
     *   "MyObject 37.7749 -122.4194 100m"
     *   "37.7749, -122.4194, 100m"
     *   "Landmark 37.7749 -122.4194"
     *   "37.7749 -122.4194 300ft"
     * 
     * @param {string} inputString - The user input string to parse
     * @returns {Object|null} Parsed object with {name, lat, lon, alt, hasExplicitAlt} or null if invalid
     */
    parseObjectInput(inputString) {
        return parseObjectInputUtil(inputString);
    },

    /**
     * Generate the next sequential object name (Object 1, Object 2, etc.)
     * Checks existing objects to find the highest number and increments
     * @returns {string} Next sequential object name
     */
    getNextObjectName() {
        // Collect every name an already-created object could be carrying.
        // NodeMan is a CManager: it has iterate(), not getAllNodes(), and its
        // this.list entries are {data, original} wrappers rather than the nodes
        // themselves - iterate() hands us the node.
        //
        // menuText, not menuName, is where the name lands: createObjectFromInput()
        // passes it to TrackManager.addSyntheticTrack(), which sets it as menuText
        // on the spline editor node. The node ids are timestamped
        // (syntheticObject_<ms>), so scanning ids alone would never see an
        // "Object N" and the counter would be stuck at 1 forever. menuName is a
        // sitch-level property (Sit.menuName), not a node one.
        const names = [];
        NodeMan.iterate((id, node) => {
            names.push(id);
            if (node.menuText) {
                names.push(node.menuText);
            }
        });

        return nextSequentialObjectName(names);
    },

    /**
     * Create a 3D object and track from parsed input
     * @param {string} name - Object name
     * @param {number} lat - Latitude in decimal degrees
     * @param {number} lon - Longitude in decimal degrees
     * @param {number} alt - Altitude in meters (or 0 if not explicit)
     * @param {boolean} hasExplicitAlt - Whether altitude was explicitly provided
     * @returns {Object} Object with {objectNode, trackOb, objectID, trackID}
     */
    createObjectFromInput(name, lat, lon, alt, hasExplicitAlt) {
        // If altitude not explicitly provided, use terrain elevation
        let finalAlt = alt;
        if (!hasExplicitAlt) {
            finalAlt = elevationAtLL(lat, lon);
            console.log(`Using terrain elevation: ${finalAlt}m at ${lat}, ${lon}`);
        }

        // Convert LLA to ECEF coordinates
        const ecefPosition = LLAToECEF(lat, lon, finalAlt);

        // Generate unique IDs. Date.now() alone is NOT unique - two objects created
        // in the same millisecond produced the same id and the second threw out of
        // CManager.add. UniqueName() returns the timestamped name untouched in the
        // normal case and only disambiguates on an actual collision. Both ids become
        // CNode ids, and their manager entries (TrackManager) mirror those, so
        // NodeMan is the registry to check.
        const objectID = NodeMan.UniqueName(`syntheticObject_${Date.now()}`);
        const trackID = NodeMan.UniqueName(`syntheticTrack_${Date.now()}`);

        // Snapshot the node ids that exist BEFORE construction. Anything under
        // `${objectID}_` that appears afterwards was auto-created by CNode3DObject
        // (_size, _color_colorInput, _modelLength, the controllers and their GUI
        // values) and is owned by this object alone, so undo can sweep exactly those
        // and nothing else. The prefix is unique by construction - objectID carries a
        // timestamp - so the sweep can never reach an unrelated node.
        const preObjectNodeIDs = new Set(Object.keys(NodeMan.list));

        // Create the 3D object
        const objectNode = new CNode3DObject({
            id: objectID,
            geometry: "sphere",
            radius: 5,
            color: 0x808080,
            material: "phong",
            position: ecefPosition,
        });

        // Create track and associate with object
        const trackOb = TrackManager.addSyntheticTrack({
            startPoint: ecefPosition,
            name: name,
            objectID: objectID,
            editMode: true,
            color: 0x808080,
            startFrame: par.frame
        });

        const ownedNodeIds = Object.keys(NodeMan.list)
            .filter(id => id.startsWith(objectID + "_") && !preObjectNodeIDs.has(id));

        console.log(`Created object "${name}" at ${lat}, ${lon}, ${finalAlt}m`);

        // Make object creation undoable. Both entry points — the "Add Object" menu
        // (index.js) and the addObjectAtLLA API (CSitrecAPI) — route through here, and
        // previously neither pushed an undo action, so a created object could not be
        // undone (unlike synth buildings/clouds/overlays, which already register undo in
        // this file). Mirror that pattern: undo removes the synthetic track (which tears
        // down its display/data nodes), the sub-nodes the object auto-created
        // (ownedNodeIds, gathered above) and the 3D object node itself; redo re-creates
        // via this same method. We hold the live ids in closure vars because redo gets
        // fresh ids — the nested add() below is a no-op while UndoManager.isRedoing, so it
        // does not stack a duplicate action.
        if (UndoManager && trackOb) {
            UndoManager.add(makeCreateObjectUndoAction({
                name,
                objectID,
                trackID: trackOb.trackID ?? trackID,
                ownedNodeIds,
                trackManager: TrackManager,
                nodeMan: NodeMan,
                // Redo re-creates via this same method (the nested UndoManager.add is a no-op
                // while isRedoing, so it does not stack a duplicate action) and returns the
                // fresh ids so a subsequent undo targets the recreated pair.
                recreate: () => {
                    const r = this.createObjectFromInput(name, lat, lon, finalAlt, true);
                    return {
                        objectID: r.objectID,
                        trackID: r.trackOb?.trackID ?? r.trackID,
                        ownedNodeIds: r.ownedNodeIds,
                    };
                },
            }));
        }

        return { objectNode, trackOb, objectID, trackID, ownedNodeIds };
    },

    /**
     * Position camera to view a newly created object
     * Camera will be positioned 100m above and 100m south of the object
     * @param {number} lat - Object latitude in decimal degrees
     * @param {number} lon - Object longitude in decimal degrees
     * @param {number} alt - Object altitude in meters
     */
    positionCameraToViewObject(lat, lon, alt) {
        // Calculate camera position: 100m above and 100m south
        // South means reducing latitude (approximately -0.0009 degrees per 100m)
        const metersPerDegreeLat = 111320; // meters per degree latitude (approximate)
        const southOffsetDegrees = -100 / metersPerDegreeLat;

        const cameraLat = lat + southOffsetDegrees;
        const cameraLon = lon;
        const cameraAlt = alt + 100; // 100m above object

        // Try to get mainCamera first, fallback to fixedCameraPosition
        let cameraNode = null;
        if (NodeMan.exists("mainCamera")) {
            cameraNode = NodeMan.get("mainCamera");
        } else if (NodeMan.exists("fixedCameraPosition")) {
            cameraNode = NodeMan.get("fixedCameraPosition");
        }

        if (cameraNode) {
            // Use setLLA if available (for position nodes)
            if (typeof cameraNode.setLLA === 'function') {
                cameraNode.setLLA(cameraLat, cameraLon, cameraAlt);
                console.log(`Camera positioned at: ${cameraLat}, ${cameraLon}, ${cameraAlt}m (100m south and 100m above object)`);
            } else {
                // Fallback: set camera position directly using ECEF coordinates
                const cameraECEF = LLAToECEF(cameraLat, cameraLon, cameraAlt);
                const objectECEF = LLAToECEF(lat, lon, alt);

                if (cameraNode.camera) {
                    cameraNode.camera.position.copy(cameraECEF);
                    cameraNode.camera.lookAt(objectECEF);
                    console.log(`Camera positioned and looking at object`);
                } else if (cameraNode.position) {
                    cameraNode.position.copy(cameraECEF);
                }
            }
        } else {
            console.warn("No camera node found (mainCamera or fixedCameraPosition)");
        }
    },

    /**
     * Show a context menu for ground clicks with camera/target positioning options
     * @param {number} mouseX - Screen X coordinate
     * @param {number} mouseY - Screen Y coordinate
     * @param {Vector3} groundPoint - The 3D point where the ground was clicked (in ECEF coordinates)
     * @param {string} [sourceViewID] - ID of the view that triggered the menu (e.g. "mainView", "lookView")
     */
    showGroundContextMenu(mouseX, mouseY, groundPoint, sourceViewID) {
        // Check if we're in track editing mode
        if (Globals.editingTrack) {
            this.showTrackEditingMenu(mouseX, mouseY, groundPoint);
            return;
        }

        // If we're in building/clouds/overlay editing mode with menu open, do nothing
        if (Globals.editingBuilding && this.buildingEditMenu) {
            return;
        }
        if (Globals.editingClouds && this.cloudsEditMenu) {
            return;
        }
        if (Globals.editingOverlay && this.overlayEditMenu) {
            return;
        }

        // Convert ground point to LLA
        const groundLLA = ECEFToLLAVD_radii(groundPoint);
        const lat = groundLLA.x;
        const lon = groundLLA.y;
        const altHAE = groundLLA.z;
        const alt = altHAE; // legacy HAE value used by non-camera context menu actions
        const geoidOffset = meanSeaLevelOffset(lat, lon);
        const altMSL = altHAE - geoidOffset;

        // Get ground elevation at this point
        const groundElevation = elevationAtLL(lat, lon);

        // Close any existing ground context menu before creating a new one
        if (this.groundContextMenu) {
            this.groundContextMenu.destroy();
            this.groundContextMenu = null;
        }

        // Create the context menu using lil-gui standalone menu
        // Pass true for dismissOnOutsideClick so it behaves like a context menu
        const menu = Globals.menuBar.createStandaloneMenu("Ground", mouseX, mouseY, true);

        // If menu creation was blocked (persistent menu is open), return early
        if (!menu) {
            return;
        }

        menu.open();

        // Store reference to track this menu
        this.groundContextMenu = menu;

        // Format the location text: coordinates, then MSL altitude, then WGS84 HAE
        // (height above ellipsoid) with the HAE−MSL difference (the EGM96 geoid offset N,
        // negative across most of CONUS) in parentheses.
        const locationText =
            `${lat.toFixed(6)}, ${lon.toFixed(6)}<br>` +
            `${altMSL.toFixed(1)}m MSL<br>` +
            `${altHAE.toFixed(1)}m WGS84 HAE (${geoidOffset.toFixed(1)}m)`;

        // Create an object to hold the menu actions
        const menuData = {
            setCameraAbove: () => {
                if (NodeMan.exists("fixedCameraPosition")) {
                    const camera = NodeMan.get("fixedCameraPosition");
                    // Maintain current altitude, only update lat/lon
                    const currentAlt = camera.getAltitude();
                    camera.setLLA(lat, lon, currentAlt);
                    console.log(`Camera set to: ${lat}, ${lon}, ${currentAlt}m (altitude maintained)`);
                }
                this.groundContextMenu = null;
                menu.destroy();
            },
            setCameraOnGround: () => {
                if (NodeMan.exists("fixedCameraPosition")) {
                    const camera = NodeMan.get("fixedCameraPosition");
                    // Set camera at ground level (2m above ground for eye level)
                    camera.setLLA(lat, lon, altMSL + 2);
                    console.log(`Camera set to ground: ${lat}, ${lon}, ${altMSL + 2}m MSL`);
                }
                this.groundContextMenu = null;
                menu.destroy();
            },
            setTargetAbove: () => {
                if (NodeMan.exists("fixedTargetPositionWind")) {
                    const target = NodeMan.get("fixedTargetPositionWind");
                    // Maintain current altitude, only update lat/lon
                    const currentAlt = target.getAltitude();
                    target.setLLA(lat, lon, currentAlt);
                    console.log(`Target set to: ${lat}, ${lon}, ${currentAlt}m (altitude maintained)`);
                }
                this.groundContextMenu = null;
                menu.destroy();
            },
            setTargetOnGround: () => {
                if (NodeMan.exists("fixedTargetPositionWind")) {
                    const target = NodeMan.get("fixedTargetPositionWind");
                    // Set target at ground level
                    target.setLLA(lat, lon, altMSL);
                    console.log(`Target set to ground: ${lat}, ${lon}, ${altMSL}m MSL`);
                }
                this.groundContextMenu = null;
                menu.destroy();
            },
            centerTerrain: () => {
                if (NodeMan.exists("terrainUI")) {
                    const terrainUI = NodeMan.get("terrainUI");
                    terrainUI.lat = lat;
                    terrainUI.lon = lon;
                    terrainUI.flagForRecalculation();
                    console.log(`Centered terrain at: ${lat}, ${lon}`);
                }
                this.groundContextMenu = null;
                menu.destroy();
            },
            createSyntheticTrack: () => {
                // Create a track at the clicked point using TrackManager
                TrackManager.addSyntheticTrack({
                    startPoint: groundPoint,
                    name: "New Track",
                    editMode: true,
                    startFrame: par.frame,
                    showInLook: sourceViewID === "lookView",
                });
                this.groundContextMenu = null;
                menu.destroy();
            },
            addBalloon: () => {
                this.groundContextMenu = null;
                menu.destroy();

                // Simulated balloon target launched from the clicked ground
                // point (start altitude = ground MSL there; ascends on launch
                // and drifts with the loaded wind profile). Adds itself to the
                // Camera/Target Track switches, so it can be tracked/filmed.
                const trackOb = TrackManager.addBalloonTrack({
                    startLat: lat,
                    startLon: lon,
                    startAltitude: Math.max(0, altMSL),
                    showInLook: sourceViewID === "lookView",
                });

                if (trackOb && UndoManager) {
                    // capture the full generator record so redo recreates the
                    // same node ids (mirrors the building/clouds undo pattern)
                    const record = TrackManager.serializeBalloons()
                        .find(b => b.trackID === trackOb.trackID);
                    let curTrackID = trackOb.trackID;
                    UndoManager.add({
                        undo: () => {
                            TrackManager.disposeRemove(curTrackID);
                        },
                        redo: () => {
                            const ob = TrackManager.addBalloonTrack(record);
                            curTrackID = ob?.trackID ?? curTrackID;
                        },
                        description: `Add balloon "${trackOb.menuText}"`
                    });
                }
            },
            // Place something in the world that does not move.
            //
            // An object still needs a track to say where it is — CNode3DObject has no
            // position of its own, a TrackPosition controller asks a track every frame —
            // but a thing sitting on the ground has no journey to describe, and giving it a
            // synthetic spline track means an entry in Contents, a spline editor and a set
            // of keyframes that exist only to say "here, always".
            //
            // So it gets a CNodePositionLLA instead: a single lat/lon/alt that satisfies
            // the same interface. It is hidden from the UI by NOT being registered with
            // TrackManager — TrackManager is what creates the Contents folder and what the
            // track pickers enumerate — and by being constructed with no `gui`, so it adds
            // no controls anywhere.
            //
            // Dragging keeps working with no extra wiring: CObjectMoveWidget's
            // resolveMoveTarget() already recognises a fixed position by behaviour
            // (setLLA + _LLA + ecef) rather than by class, precisely so "the camera's and
            // target's position nodes, and any future kin, all qualify".
            addFixedObject: () => {
                const objectID = NodeMan.UniqueName(`syntheticObject_${Date.now()}`);
                const positionID = NodeMan.UniqueName(`objectPosition_${Date.now()}`);

                // No `gui`, so no controls are created for it. MSL to match the other
                // ground-menu placements (setTargetOnGround and friends use altMSL).
                new CNodePositionLLA({
                    id: positionID,
                    LLA: [lat, lon, altMSL],
                });

                const objectNode = new CNode3DObject({
                    id: objectID,
                    geometry: "sphere",
                    radius: 5,
                    color: 0x808080,
                    material: "phong",
                    position: groundPoint,
                });

                // Position only. No ObjectTilt: that orients a model along its direction of
                // travel, and this one has none — it would also drag in a smoothed-track
                // node that would then need disposing.
                objectNode.addController("TrackPosition", {
                    sourceTrack: positionID,
                });

                console.log(`Created fixed object ${objectID} at ${lat}, ${lon}, ${altMSL}m MSL`);
                this.groundContextMenu = null;
                menu.destroy();

                // Go straight into edit mode for the thing just created.
                //
                // Two reasons it is worth doing here rather than leaving the user to find
                // and click the object: a grey 5m sphere on open ground is genuinely hard
                // to spot, and CObjectMoveWidget attaches to whatever getEditingObjectNode()
                // returns — so opening the menu IS what makes the object draggable without
                // holding Option.
                //
                // AFTER menu.destroy() above: createStandaloneMenu refuses while another
                // persistent menu is open, so the ground menu has to be gone first.
                //
                // The same call the right-click path makes, so the window is identical
                // and lands in the identical place.
                this.showNodeEditMenu(objectNode, mouseX, mouseY);

                if (UndoManager) {
                    UndoManager.add({
                        undo: () => {
                            NodeMan.disposeRemove(objectID);
                            NodeMan.disposeRemove(positionID);
                        },
                        redo: () => {
                            new CNodePositionLLA({id: positionID, LLA: [lat, lon, altMSL]});
                            const ob = new CNode3DObject({
                                id: objectID, geometry: "sphere", radius: 5,
                                color: 0x808080, material: "phong", position: groundPoint,
                            });
                            ob.addController("TrackPosition", {sourceTrack: positionID});
                        },
                        description: "Add 3D object",
                    });
                }
            },

            createTrackWithObject: () => {
                // Create a 3D object at the clicked point (see createObjectFromInput
                // for why the timestamped ids go through UniqueName)
                const objectID = NodeMan.UniqueName(`syntheticObject_${Date.now()}`);
                const trackID = NodeMan.UniqueName(`syntheticTrack_${Date.now()}`);

                // Create a simple grey sphere object (5m radius) with phong material
                const objectNode = new CNode3DObject({
                    id: objectID,
                    geometry: "sphere",
                    radius: 5, // 5 meters
                    color: 0x808080, // grey
                    material: "phong",
                    position: groundPoint,
                });

                // Create track and associate with object using TrackManager
                // Controllers (TrackPosition and ObjectTilt) are added automatically by addSyntheticTrack
                const trackOb = TrackManager.addSyntheticTrack({
                    startPoint: groundPoint,
                    name: `Object Track`,
                    objectID: objectID,
                    editMode: true,
                    color: 0x808080, // grey
                    startFrame: par.frame,
                    showInLook: sourceViewID === "lookView",
                });



                console.log(`Created object ${objectID} with track at ${lat}, ${lon}, ${alt}m`);
                this.groundContextMenu = null;
                menu.destroy();
            },
            dropPin: () => {
                // Close the menu first
                this.groundContextMenu = null;
                menu.destroy();

                // Create a unique feature ID. CNodeFeatureMarker registers in NodeMan
                // and FeatureManager mirrors that id, so NodeMan is the registry to check.
                const featureID = NodeMan.UniqueName(`feature_${Date.now()}`);

                // Create the feature at the ground location
                const featureNode = FeatureManager.addFeature({
                    id: featureID,
                    text: "New Feature",
                    positionLLA: {
                        lat: lat,
                        lon: lon,
                        alt: alt  // Will conform to ground
                    }
                });

                // Open the editing menu with focus on the text field. The view is
                // where the pin can then be dragged around.
                FeatureManager.showFeatureEditMenu(featureNode, mouseX, mouseY, true,
                    sourceViewID ? ViewMan.get(sourceViewID, false) : null);

                console.log(`Created feature ${featureID} at ${lat}, ${lon}, ${alt}m`);
            },
            addBuilding: () => {
                this.groundContextMenu = null;
                menu.destroy();

                const building = Synth3DManager.createBuildingAtPoint(groundPoint);

                // Add undo action for building creation
                if (building && UndoManager) {
                    const buildingID = building.buildingID;
                    const buildingState = building.serialize();

                    UndoManager.add({
                        undo: () => {
                            // Delete the created building
                            Synth3DManager.removeBuilding(buildingID);
                        },
                        redo: () => {
                            // Recreate the building
                            Synth3DManager.addBuilding(buildingState);
                        },
                        description: `Create building "${building.name}"`
                    });
                }

                if (building) {
                    building.setEditMode(true);
                    console.log(`Created building at ground point, now in edit mode`);
                }
            },
            addClouds: () => {
                this.groundContextMenu = null;
                menu.destroy();

                const clouds = Synth3DManager.createCloudsAtPoint(groundPoint);

                if (clouds && UndoManager) {
                    const cloudsID = clouds.cloudsID;
                    const cloudsState = clouds.serialize();

                    UndoManager.add({
                        undo: () => {
                            Synth3DManager.removeClouds(cloudsID);
                        },
                        redo: () => {
                            Synth3DManager.addClouds(cloudsState);
                        },
                        description: `Create cloud layer "${clouds.name}"`
                    });
                }

                if (clouds) {
                    clouds.setEditMode(true);
                    console.log(`Created clouds at ground point, now in edit mode`);
                }
            },
            addOverlay: () => {
                this.groundContextMenu = null;
                menu.destroy();

                const overlay = Synth3DManager.createOverlayAtPoint(groundPoint);

                if (overlay && UndoManager) {
                    const overlayID = overlay.overlayID;
                    const overlayState = overlay.serialize();

                    UndoManager.add({
                        undo: () => {
                            Synth3DManager.removeOverlay(overlayID);
                        },
                        redo: () => {
                            Synth3DManager.addOverlay(overlayState);
                        },
                        description: `Create ground overlay "${overlay.name}"`
                    });
                }

                if (overlay) {
                    overlay.setEditMode(true);
                    console.log(`Created overlay at ground point, now in edit mode`);
                }
            },
            addGrid: () => {
                this.groundContextMenu = null;
                menu.destroy();

                const grid = Synth3DManager.createGridAtPoint(groundPoint);

                if (grid && UndoManager) {
                    const gridID = grid.overlayID;
                    const gridState = grid.serialize();

                    UndoManager.add({
                        undo: () => {
                            Synth3DManager.removeOverlay(gridID);
                        },
                        redo: () => {
                            Synth3DManager.addOverlay(gridState);
                        },
                        description: `Create ground grid "${grid.name}"`
                    });
                }

                if (grid) {
                    grid.setEditMode(true);
                    console.log(`Created grid at ground point, now in edit mode`);
                }
            },
            googleMapsHere: () => {
                this.groundContextMenu = null;
                menu.destroy();

                // Open Google Maps at the clicked location. Not in the secure build: the
                // address would carry the clicked position to an external site.
                if (isSecureBuild) {
                    console.log("External map links are not available in the secure build");
                    return;
                }
                const googleMapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
                window.open(googleMapsUrl, '_blank');
                console.log(`Opening Google Maps at: ${lat}, ${lon}`);
            },
            googleEarthHere: () => {
                this.groundContextMenu = null;
                menu.destroy();

                const kmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2" xmlns:kml="http://www.opengis.net/kml/2.2" xmlns:atom="http://www.w3.org/2005/Atom">
<Document>
\t<name>Sitrec Pin.kml</name>
\t<StyleMap id="m_ylw-pushpin">
\t\t<Pair>
\t\t\t<key>normal</key>
\t\t\t<styleUrl>#s_ylw-pushpin</styleUrl>
\t\t</Pair>
\t\t<Pair>
\t\t\t<key>highlight</key>
\t\t\t<styleUrl>#s_ylw-pushpin_hl</styleUrl>
\t\t</Pair>
\t</StyleMap>
\t<Style id="s_ylw-pushpin">
\t\t<IconStyle>
\t\t\t<scale>1.1</scale>
\t\t\t<Icon>
\t\t\t\t<href>http://maps.google.com/mapfiles/kml/pushpin/ylw-pushpin.png</href>
\t\t\t</Icon>
\t\t\t<hotSpot x="20" y="2" xunits="pixels" yunits="pixels"/>
\t\t</IconStyle>
\t</Style>
\t<Style id="s_ylw-pushpin_hl">
\t\t<IconStyle>
\t\t\t<scale>1.3</scale>
\t\t\t<Icon>
\t\t\t\t<href>http://maps.google.com/mapfiles/kml/pushpin/ylw-pushpin.png</href>
\t\t\t</Icon>
\t\t\t<hotSpot x="20" y="2" xunits="pixels" yunits="pixels"/>
\t\t</IconStyle>
\t</Style>
\t<Placemark>
\t\t<name>Sitrec Pin</name>
\t\t<LookAt>
\t\t\t<longitude>${lon}</longitude>
\t\t\t<latitude>${lat}</latitude>
\t\t\t<altitude>0</altitude>
\t\t\t<heading>0</heading>
\t\t\t<tilt>0</tilt>
\t\t\t<range>10000</range>
\t\t\t<gx:altitudeMode>relativeToSeaFloor</gx:altitudeMode>
\t\t</LookAt>
\t\t<styleUrl>#m_ylw-pushpin</styleUrl>
\t\t<Point>
\t\t\t<gx:drawOrder>1</gx:drawOrder>
\t\t\t<coordinates>${lon},${lat},0</coordinates>
\t\t</Point>
\t</Placemark>
</Document>
</kml>`;

                const blob = new Blob([kmlContent], { type: 'application/vnd.google-earth.kml+xml' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'Sitrec Pin.kml';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                console.log(`Downloaded KML for Google Earth at: ${lat}, ${lon}`);
            },
        };
        
        const overlayAtPoint = Synth3DManager.findOverlayAtLatLon(lat, lon);
        if (overlayAtPoint) {
            const isEditing = overlayAtPoint.editMode;
            menuData.editOverlay = () => {
                this.groundContextMenu = null;
                menu.destroy();
                
                if (isEditing) {
                    overlayAtPoint.setEditMode(false);
                    console.log(`Exited edit mode for overlay: ${overlayAtPoint.id}`);
                } else {
                    Synth3DManager.exitAllEditModes(overlayAtPoint);
                    overlayAtPoint.setEditMode(true);
                    console.log(`Editing overlay: ${overlayAtPoint.id}`);
                }
            };
        }
        
        const cloudsAtPoint = Synth3DManager.findCloudsAtLatLon(lat, lon);
        if (cloudsAtPoint) {
            const isEditingClouds = cloudsAtPoint.editMode;
            menuData.editClouds = () => {
                this.groundContextMenu = null;
                menu.destroy();
                
                if (isEditingClouds) {
                    cloudsAtPoint.setEditMode(false);
                    console.log(`Exited edit mode for clouds: ${cloudsAtPoint.id}`);
                } else {
                    Synth3DManager.exitAllEditModes(cloudsAtPoint);
                    cloudsAtPoint.setEditMode(true);
                    console.log(`Editing clouds: ${cloudsAtPoint.id}`);
                }
            };
        }

        // Add location text as custom HTML (bright and selectable)
        menu.addHTML(locationText, "Location");

        // Add menu items
        menu.add(menuData, "setCameraAbove").name(t("custom.contextMenu.setCameraAbove"));
        menu.add(menuData, "setCameraOnGround").name(t("custom.contextMenu.setCameraOnGround"));
        menu.add(menuData, "setTargetAbove").name(t("custom.contextMenu.setTargetAbove"));
        menu.add(menuData, "setTargetOnGround").name(t("custom.contextMenu.setTargetOnGround"));

        // Add feature marker option
        menu.add(menuData, "dropPin").name(t("custom.contextMenu.dropPin"));

        // Add synthetic track options
        menu.add(menuData, "addFixedObject").name(t("custom.contextMenu.addFixedObject"));
        menu.add(menuData, "createTrackWithObject").name(t("custom.contextMenu.createTrackWithObject"));
        menu.add(menuData, "createSyntheticTrack").name(t("custom.contextMenu.createTrackNoObject"));

        // Add simulated balloon target
        menu.add(menuData, "addBalloon").name(t("custom.contextMenu.addBalloon", {defaultValue: "Add Balloon"}));

        // Add building creation option
        menu.add(menuData, "addBuilding").name(t("custom.contextMenu.addBuilding"));

        // Add clouds options
        if (cloudsAtPoint) {
            const cloudsLabel = cloudsAtPoint.name || cloudsAtPoint.id;
            const cloudsMenuLabel = cloudsAtPoint.editMode ? `Exit Edit: ${cloudsLabel}` : `Edit Clouds: ${cloudsLabel}`;
            menu.add(menuData, "editClouds").name(cloudsMenuLabel);
        }
        menu.add(menuData, "addClouds").name(t("custom.contextMenu.addClouds"));

        // Add ground overlay/grid options
        if (overlayAtPoint) {
            const overlayLabel = overlayAtPoint.name || overlayAtPoint.id;
            const kindLabel = overlayAtPoint.kindName === "grid" ? "Grid" : "Overlay";
            const menuLabel = overlayAtPoint.editMode ? `Exit Edit: ${overlayLabel}` : `Edit ${kindLabel}: ${overlayLabel}`;
            menu.add(menuData, "editOverlay").name(menuLabel);
        }
        menu.add(menuData, "addOverlay").name(t("custom.contextMenu.addGroundOverlay"));
        menu.add(menuData, "addGrid").name(t("custom.contextMenu.addGroundGrid"));

        if (NodeMan.exists("terrainUI")) {
            const terrainUI = NodeMan.get("terrainUI");
            if (!terrainUI.dynamic) {
                menu.add(menuData, "centerTerrain").name(t("custom.contextMenu.centerTerrain"));
            }

        }

        // Add Google Maps link if extraHelpLinks is enabled. The secure build never offers
        // the external map link; the Google Earth entry only writes a local KML file.
        if (configParams?.extraHelpLinks) {
            if (!isSecureBuild) {
                menu.add(menuData, "googleMapsHere").name(t("custom.contextMenu.googleMapsHere"));
            }
            menu.add(menuData, "googleEarthHere").name(t("custom.contextMenu.googleEarthHere"));
        }
    },

    /**
     * Show a context menu for track editing when in edit mode
     * @param {number} mouseX - Screen X coordinate
     * @param {number} mouseY - Screen Y coordinate
     * @param {Vector3} groundPoint - The 3D point where the ground was clicked (in ECEF coordinates)
     */
    showTrackEditingMenu(mouseX, mouseY, groundPoint) {
        const trackOb = Globals.editingTrack;
        if (!trackOb || !trackOb.splineEditor) {
            console.warn("No track being edited");
            return;
        }

        const splineEditor = trackOb.splineEditor;
        const shortName = trackOb.menuText || trackOb.trackID;

        // Check if current frame already has a control point
        const currentFrame = par.frame;
        const hasPointAtCurrentFrame = splineEditor.frameNumbers.includes(currentFrame);

        // Create the context menu
        const menu = Globals.menuBar.createStandaloneMenu(`Edit: ${shortName}`, mouseX, mouseY);
        menu.open();

        // Create menu actions
        const menuData = {
            splitTrack: () => {
                // Add a point at the current frame and current track position
                // Get the track node to access the interpolated position
                const trackNode = trackOb.splineEditorNode;
                assert(!trackNode?._needsRecalculate, "call ensureRecalculated() before direct array access on " + trackNode?.id);
                if (trackNode && trackNode.array && trackNode.array.length > 0) {
                    const currentFrame = Math.floor(par.frame);
                    if (currentFrame >= 0 && currentFrame < trackNode.array.length) {
                        const trackPosition = trackNode.array[currentFrame].position;
                        if (trackPosition) {
                            splineEditor.insertPoint(par.frame, trackPosition);
                            console.log(`Split track ${shortName} at frame ${par.frame} (position indicator)`);
                        } else {
                            console.warn("No track position available at current frame");
                        }
                    } else {
                        console.warn("Current frame out of range");
                    }
                } else {
                    console.warn("Track node or array not available");
                }
                menu.destroy();
                setRenderOne(true);
            },
            addGroundPoint: () => {
                // Add a point at the current frame and clicked position
                splineEditor.insertPoint(par.frame, groundPoint);
                console.log(`Added ground point to track ${shortName} at frame ${par.frame}`);
                menu.destroy();
                setRenderOne(true);
            },
            removeClosestPoint: () => {
                // Find the closest point to the clicked position
                let closestIndex = -1;
                let closestDistance = Infinity;

                for (let i = 0; i < splineEditor.numPoints; i++) {
                    const pointPos = splineEditor.positions[i];
                    const distance = groundPoint.distanceTo(pointPos);
                    if (distance < closestDistance) {
                        closestDistance = distance;
                        closestIndex = i;
                    }
                }

                if (closestIndex >= 0) {
                    const frameNumber = splineEditor.frameNumbers[closestIndex];

                    // removePointByIndex owns the "never the last one" rule and all the
                    // array/scene surgery, so this path and the right-click-a-point path
                    // can never disagree about what removing a point means. (It used to
                    // be duplicated here, behind a native alert().)
                    if (!splineEditor.removePointByIndex(closestIndex)) {
                        showError(`Cannot remove the only control point of "${shortName}"`);
                        menu.destroy();
                        return;
                    }

                    console.log(`Removed point at frame ${frameNumber} from track ${shortName}`);
                    setRenderOne(true);
                } else {
                    console.warn("No point found to remove");
                }
                menu.destroy();
            },
            exitEditMode: () => {
                // Exit edit mode
                trackOb.editMode = false;
                splineEditor.setEnable(false);
                Globals.editingTrack = null;
                console.log(`Exited edit mode for track ${shortName}`);
                menu.destroy();
            }
        };

        // Add menu items
        // Only show point-adding options if current frame doesn't already have a control point
        if (!hasPointAtCurrentFrame) {
            menu.add(menuData, "splitTrack").name(`Split Track (Frame ${par.frame})`);
            menu.add(menuData, "addGroundPoint").name(`Add Ground Point (Frame ${par.frame})`);
        }
        menu.add(menuData, "removeClosestPoint").name(t("custom.contextMenu.removeClosestPoint"));
        menu.add(menuData, "exitEditMode").name(t("custom.contextMenu.exitEditMode"));
    },

    showBuildingEditingMenu(mouseX, mouseY) {
        const building = Globals.editingBuilding;
        if (!building || !building.guiFolder) {
            console.warn("No building being edited or no GUI folder");
            return;
        }
        
        // Ensure edit mode is enabled when showing the menu
        if (!building.editMode) {
            building.setEditMode(true);
        }

        // Check saved sidebar state first (saved before menu destruction in setEditMode)
        let wasInLeftSidebar = this.lastBuildingEditMenuSidebar === 'left';
        let wasInRightSidebar = this.lastBuildingEditMenuSidebar === 'right';
        
        // Also check current menu if it still exists
        if (this.buildingEditMenu) {
            if (isInLeftSidebar(this.buildingEditMenu)) wasInLeftSidebar = true;
            if (isInRightSidebar(this.buildingEditMenu)) wasInRightSidebar = true;
            this.buildingEditMenu.destroy(true, true); // skipEditModeDisable=true since we're just relocating
            this.buildingEditMenu = null;
        }
        
        // Clear saved state after using it
        this.lastBuildingEditMenuSidebar = null;

        const buildingName = building.name || building.buildingID;
        const standaloneMenu = Globals.menuBar.createStandaloneMenu(`Edit: ${buildingName}`, mouseX, mouseY);
        this.buildingEditMenu = standaloneMenu;
        
        this.setupDynamicMirroring(building.guiFolder, standaloneMenu);
        
        if (wasInLeftSidebar) {
            addMenuToLeftSidebar(standaloneMenu);
            standaloneMenu.mode = "SIDEBAR_LEFT";
            standaloneMenu.lockOpenClose = false;
            standaloneMenu.open();
            standaloneMenu.lockOpenClose = true;
            Globals.menuBar.applyModeStyles(standaloneMenu);
        } else if (wasInRightSidebar) {
            addMenuToRightSidebar(standaloneMenu);
            standaloneMenu.mode = "SIDEBAR_RIGHT";
            standaloneMenu.lockOpenClose = false;
            standaloneMenu.open();
            standaloneMenu.lockOpenClose = true;
            Globals.menuBar.applyModeStyles(standaloneMenu);
        } else {
            standaloneMenu.open();
        }
    },

    showCloudsEditingMenu(mouseX, mouseY) {
        const clouds = Globals.editingClouds;
        if (!clouds || !clouds.guiFolder) {
            console.warn("No clouds being edited or no GUI folder");
            return;
        }

        // Ensure edit mode is enabled when showing the menu
        if (!clouds.editMode) {
            clouds.setEditMode(true);
        }

        let wasInLeftSidebar = false;
        let wasInRightSidebar = false;
        if (this.cloudsEditMenu) {
            wasInLeftSidebar = isInLeftSidebar(this.cloudsEditMenu);
            wasInRightSidebar = isInRightSidebar(this.cloudsEditMenu);
            this.cloudsEditMenu.destroy(true, true); // skipEditModeDisable=true since we're just relocating
            this.cloudsEditMenu = null;
        }

        const cloudsName = clouds.name || clouds.cloudsID;
        const standaloneMenu = Globals.menuBar.createStandaloneMenu(`Edit: ${cloudsName}`, mouseX, mouseY);
        this.cloudsEditMenu = standaloneMenu;
        
        this.setupDynamicMirroring(clouds.guiFolder, standaloneMenu);
        
        if (wasInLeftSidebar) {
            addMenuToLeftSidebar(standaloneMenu);
            standaloneMenu.mode = "SIDEBAR_LEFT";
            standaloneMenu.lockOpenClose = false;
            standaloneMenu.open();
            standaloneMenu.lockOpenClose = true;
            Globals.menuBar.applyModeStyles(standaloneMenu);
        } else if (wasInRightSidebar) {
            addMenuToRightSidebar(standaloneMenu);
            standaloneMenu.mode = "SIDEBAR_RIGHT";
            standaloneMenu.lockOpenClose = false;
            standaloneMenu.open();
            standaloneMenu.lockOpenClose = true;
            Globals.menuBar.applyModeStyles(standaloneMenu);
        } else {
            standaloneMenu.open();
        }
    },

    showOverlayEditingMenu(overlay, mouseX, mouseY) {
        if (!overlay || !overlay.guiFolder) {
            console.warn("No overlay or no GUI folder");
            return;
        }

        // Ensure edit mode is enabled when showing the menu
        if (!overlay.editMode && overlay.setEditMode) {
            overlay.setEditMode(true);
        }

        let wasInLeftSidebar = false;
        let wasInRightSidebar = false;
        if (this.overlayEditMenu) {
            wasInLeftSidebar = isInLeftSidebar(this.overlayEditMenu);
            wasInRightSidebar = isInRightSidebar(this.overlayEditMenu);
            this.overlayEditMenu.destroy(true, true); // skipEditModeDisable=true since we're just relocating
            this.overlayEditMenu = null;
        }

        const overlayName = overlay.name || overlay.overlayID;
        const standaloneMenu = Globals.menuBar.createStandaloneMenu(`Edit: ${overlayName}`, mouseX, mouseY);
        this.overlayEditMenu = standaloneMenu;
        
        this.setupDynamicMirroring(overlay.guiFolder, standaloneMenu);
        
        if (wasInLeftSidebar) {
            addMenuToLeftSidebar(standaloneMenu);
            standaloneMenu.mode = "SIDEBAR_LEFT";
            standaloneMenu.lockOpenClose = false;
            standaloneMenu.open();
            standaloneMenu.lockOpenClose = true;
            Globals.menuBar.applyModeStyles(standaloneMenu);
        } else if (wasInRightSidebar) {
            addMenuToRightSidebar(standaloneMenu);
            standaloneMenu.mode = "SIDEBAR_RIGHT";
            standaloneMenu.lockOpenClose = false;
            standaloneMenu.open();
            standaloneMenu.lockOpenClose = true;
            Globals.menuBar.applyModeStyles(standaloneMenu);
        } else {
            standaloneMenu.open();
        }
    },

};
