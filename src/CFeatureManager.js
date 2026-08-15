import {CManager} from "./CManager";
import {showConfirm} from "./showError";
import {CNodeFeatureMarker} from "./nodes/CNodeLabels3D";
import {Globals, NodeMan, setRenderOne, UndoManager} from "./Globals";
import {Raycaster, Vector3} from "three";
import {ViewMan} from "./CViewManager";
import {t} from "./i18n";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";
import {raycastLocalGround} from "./raycastGround";
import {screenToNDC} from "./mouseMoveView";
import {mouseInViewOnly} from "./ViewUtils";
import {getPointBelowLL} from "./threeExt";

// Screen-space pick radius for a pin, in pixels. Pins are drawn screen-space
// invariant (a fixed-length arrow with the label on top), so both right-click
// picking and edit-mode dragging hit-test in screen space instead of raycasting
// the 3D scene.
const FEATURE_PICK_RADIUS = 30;

/**
 * CFeatureManager
 * Manages geographic feature markers (labels with arrows pointing to locations)
 * Similar to TrackManager, but for static geographic features
 */
class CFeatureManager extends CManager {
    constructor() {
        super();

        // Edit mode state. A pin's "Edit:" menu IS its edit mode, matching the
        // building / clouds / overlay editing menus: while the menu is up the pin
        // can be dragged around, and only Done, Escape, a double-click on the menu
        // title, or dragging the menu off screen leaves edit mode.
        this.editingFeature = null;
        this.editMenu = null;
        this.editView = null;
        this.editReadout = null;
        this.isDragging = false;
        this.hoveringFeature = false;
        this.raycaster = new Raycaster();
    }

    /**
     * Add a feature marker
     * @param {Object} options - Feature marker creation options
     * @param {string} options.id - Unique identifier for the marker
     * @param {string} options.text - Label text to display
     * @param {Object} options.positionLLA - Position in lat/lon/alt
     * @param {number} options.positionLLA.lat - Latitude
     * @param {number} options.positionLLA.lon - Longitude
     * @param {number} options.positionLLA.alt - Altitude (0 = conform to ground)
     * @returns {CNodeFeatureMarker} The created feature marker node
     */
    addFeature(options) {
        const featureNode = new CNodeFeatureMarker(options);
        
        // Add to manager with the node's ID
        this.add(featureNode.id, featureNode);
        
        console.log(`Added feature marker: ${options.text} at (${options.positionLLA.lat}, ${options.positionLLA.lon}, ${options.positionLLA.alt})`);
        
        return featureNode;
    }

    /**
     * Remove a feature marker
     * @param {string} id - The feature marker ID to remove
     */
    removeFeature(id) {
        if (this.exists(id)) {
            // If this pin is the one being edited, close its edit menu.
            // stopEditing() first so the menu's destroy hook doesn't re-enter here.
            if (this.editingFeature && this.editingFeature.id === id && this.editMenu) {
                const menu = this.editMenu;
                this.stopEditing();
                menu.destroy();
            }


            // Remove from NodeMan if it's registered there
            if (NodeMan.exists(id)) {
                const node = NodeMan.get(id);

                // Unlink from downstream outputs (same as unlinkDisposeRemove)
                for (const outputNode of node.outputs) {
                    for (const key in outputNode.inputs) {
                        if (outputNode.inputs[key] === node) {
                            delete outputNode.inputs[key];
                        }
                    }
                }
                node.outputs = [];

                // Dispose with recursive input removal so auto-created
                // sub-nodes (like _color_colorInput) are cleaned up too.
                NodeMan.disposeRemove(id, true);
            }

            // Remove from this manager
            this.remove(id);

            console.log(`Removed feature marker: ${id}`);
        }
    }

    /**
     * Remove all feature markers
     */
    removeAll() {
        const ids = Object.keys(this.list);
        ids.forEach(id => {
            this.removeFeature(id);
        });
        console.log(`Removed all ${ids.length} feature markers`);
    }

    /**
     * Remove everything, e.g. when a new sitch is loaded.
     * Leaves edit mode first, so we don't keep listening for drags on a pin that
     * no longer exists.
     */
    disposeAll() {
        if (this.editMenu) {
            const menu = this.editMenu;
            this.stopEditing();
            menu.destroy();
        }
        super.disposeAll();
    }

    /**
     * Serialize all feature markers
     * This is called during the serialization process to save feature markers
     * @returns {Array} Array of feature marker data objects
     */
    serialize() {
        const features = [];
        
        this.iterate((key, featureNode) => {
            if (featureNode.lla) {
                const featureData = {
                    id: featureNode.id,
                    text: featureNode.text,
                    lat: featureNode.lla.lat,
                    lon: featureNode.lla.lon,
                    alt: featureNode.lla.alt,
                    arrowLength: featureNode.arrowLength ?? 100,
                    arrowColor: featureNode.arrowColor ?? 0xFF0000,
                    textColor: featureNode.textColor ?? 0xFFFFFF,
                };
                
                features.push(featureData);
            }
        });
        
        if (features.length > 0) {
            console.log(`Serialized ${features.length} feature marker(s)`);
        }
        
        return features;
    }

    /**
     * Deserialize feature markers
     * This is called during the deserialization process to recreate feature markers
     * @param {Array} featuresData - Array of feature marker data objects
     */
    deserialize(featuresData) {
        if (!featuresData || featuresData.length === 0) {
            console.log("No feature markers to deserialize");
            return;
        }
        
        console.log(`Deserializing ${featuresData.length} feature marker(s)`);
        
        for (const featureData of featuresData) {
            try {
                // If the feature already exists (e.g., created by KML extraction
                // during file loading), remove it first so the saved version
                // (which may have user edits) takes precedence.
                if (this.exists(featureData.id)) {
                    this.removeFeature(featureData.id);
                }

                this.addFeature({
                    id: featureData.id,
                    text: featureData.text,
                    positionLLA: {
                        lat: featureData.lat,
                        lon: featureData.lon,
                        alt: featureData.alt
                    },
                    arrowLength: featureData.arrowLength ?? 100,
                    arrowColor: featureData.arrowColor ?? 0xFF0000,
                    textColor: featureData.textColor ?? 0xFFFFFF
                });
                
                console.log(`Deserialized feature marker: ${featureData.text}`);
            } catch (error) {
                console.error(`Failed to deserialize feature marker ${featureData.id}:`, error);
            }
        }
    }

    /**
     * Handle context menu for feature markers using screen-space checking
     * This is more reliable than raycasting for screen-space invariant markers
     * @param {number} mouseX - Screen X coordinate (clientX)
     * @param {number} mouseY - Screen Y coordinate (clientY)
     * @param {CNodeView3D} view - The view that was clicked
     * @returns {boolean} True if a feature was found and menu was shown, false otherwise
     */
    handleContextMenu(mouseX, mouseY, view) {
        if (!view.camera) return false;

        let closestFeature = null;
        let closestDistance = FEATURE_PICK_RADIUS;

        // Iterate through all features and check screen-space distance
        this.iterate((id, featureNode) => {
            const distance = this.screenDistanceToFeature(featureNode, view, mouseX, mouseY);
            if (distance < closestDistance) {
                closestDistance = distance;
                closestFeature = featureNode;
            }
        });

        // If we found a feature, show the edit menu
        if (closestFeature) {
            this.showFeatureEditMenu(closestFeature, mouseX, mouseY, false, view);
            return true;
        }

        return false;
    }

    /**
     * The two grab points of a pin, in absolute screen pixels: the arrow base on
     * the ground, and the label sitting arrowLength pixels above it.
     * @returns {Array<{x: number, y: number}>} empty if hidden or behind the camera
     */
    featureScreenPoints(featureNode, view) {
        const points = [];
        if (!view || !view.camera) return points;
        if (!featureNode.featurePosition || !featureNode.group.visible) return points;

        const positions = [
            featureNode.featurePosition,  // Arrow base
            view.offsetScreenPixels(featureNode.featurePosition.clone(), 0, featureNode.arrowLength)  // Label position
        ];

        // Note: leftPx/topPx are container-relative, add screenOffsetX for absolute screen position
        const containerOffsetX = ViewMan.screenOffsetX || 0;

        for (const pos3D of positions) {
            // Project to screen space
            const screenPos = new Vector3(pos3D.x, pos3D.y, pos3D.z);
            screenPos.project(view.camera);

            // Skip if behind camera
            if (screenPos.z > 1) continue;

            points.push({
                x: (screenPos.x * 0.5 + 0.5) * view.widthPx + view.leftPx + containerOffsetX,
                y: (1 - (screenPos.y * 0.5 + 0.5)) * view.heightPx + view.topPx,
            });
        }

        return points;
    }

    /**
     * Distance in screen pixels from (mouseX, mouseY) to the nearest grab point
     * of a pin, or Infinity if the pin has no visible grab point in this view.
     */
    screenDistanceToFeature(featureNode, view, mouseX, mouseY) {
        let closest = Infinity;
        for (const point of this.featureScreenPoints(featureNode, view)) {
            const distance = Math.hypot(mouseX - point.x, mouseY - point.y);
            if (distance < closest) {
                closest = distance;
            }
        }
        return closest;
    }

    /**
     * Show the edit menu for a feature marker.
     * The menu is persistent (like the building / clouds / overlay "Edit:" menus):
     * while it is up we are in edit mode for that pin and it can be dragged around
     * the ground. Clicking elsewhere does NOT close it - only Done, Escape, a
     * double-click on the title, or dragging the menu off screen.
     * @param {CNodeFeatureMarker} featureNode - The feature to edit
     * @param {number} clientX - Screen X coordinate for menu placement
     * @param {number} clientY - Screen Y coordinate for menu placement
     * @param {boolean} focusOnText - Whether to focus on the text field (default: false)
     * @param {CNodeView3D} [view] - The view the pin is being edited in (for dragging)
     */
    showFeatureEditMenu(featureNode, clientX, clientY, focusOnText = false, view = null) {
        console.log(`Editing feature: ${featureNode.id}`);

        // Create an edit menu for the feature
        const menuTitle = `Edit: ${featureNode.text || "(blank)"}`;
        const standaloneMenu = Globals.menuBar.createStandaloneMenu(menuTitle, clientX, clientY, false);

        // If menu creation was blocked, return early
        if (!standaloneMenu) {
            return;
        }

        // Add editable text field
        const editableData = {
            text: featureNode.text
        };

        const textController = standaloneMenu.add(editableData, 'text')
            .name(t("featureManager.labelText"))
            .listen()
            .onChange((value) => {
                // Update the feature's text
                featureNode.text = value;
                // Update the menu title
                standaloneMenu.title(value ? `Edit: ${value}` : `Edit: (blank)`);
            });

        // Add location info (read-only). The stored altitude is HAE (height above the
        // WGS84 ellipsoid). Show all three forms: MSL = HAE - N, HAE, and the geoid
        // offset N = HAE - MSL (shown in parentheses on the HAE row, negative across CONUS).
        // The values live on this.editReadout so dragging the pin updates them live.
        if (featureNode.lla) {
            const readout = {lat: "", lon: "", altMSL: "", altHAE: ""};
            this.editReadout = readout;
            this.updateEditReadout(featureNode);
            standaloneMenu.add(readout, 'lat').name(t("featureManager.latitude")).listen().disable();
            standaloneMenu.add(readout, 'lon').name(t("featureManager.longitude")).listen().disable();
            standaloneMenu.add(readout, 'altMSL').name(t("featureManager.altitudeMSL")).listen().disable();
            standaloneMenu.add(readout, 'altHAE').name(t("featureManager.altitudeHAE")).listen().disable();
        }

        // Add arrow length slider
        standaloneMenu.add(featureNode, 'arrowLength', 0, 300, 1)
            .name(t("featureManager.arrowLength"))
            .listen()
            .onChange((value) => {
                // Update the offset.y to match the new arrow length
                // (offset is a Vector2, not individual properties)
                featureNode.offset.y = value;
            });
        
        // Add arrow color picker
        standaloneMenu.addColor(featureNode, 'arrowColor')
            .name(t("featureManager.arrowColor"))
            .listen();
        
        // Add text color picker
        standaloneMenu.addColor(featureNode, 'textColor')
            .name(t("featureManager.textColor"))
            .listen()
            .onChange((value) => {
                // Convert hex number to CSS color string for the overlay text
                const hexString = '#' + value.toString(16).padStart(6, '0');
                featureNode.color = hexString;
            });
        
        // Add Delete button
        const deleteObj = {
            deleteFeature: async () => {
                // Confirm before deleting
                const featureName = featureNode.text || 'this feature';
                if (await showConfirm(`Delete "${featureName}"?`, {title: "Delete Feature"})) {
                    // Remove the feature - this also closes the edit menu
                    this.removeFeature(featureNode.id);
                }
            }
        };
        standaloneMenu.add(deleteObj, 'deleteFeature')
            .name('🗑️ ' + t("featureManager.deleteFeature"))
            .setLabelColor('#ff4444');

        // Done button - the explicit way out of edit mode, same as Escape or a
        // double-click on the title
        const doneObj = {
            done: () => {
                standaloneMenu.destroy();
            }
        };
        standaloneMenu.add(doneObj, 'done').name(t("featureManager.done"));

        // Open the menu
        standaloneMenu.open();

        // createStandaloneMenu only measured the empty menu, so re-fit it now the
        // rows are in - otherwise Done can end up off the bottom of the screen
        Globals.menuBar.ensureMenuOnScreen(standaloneMenu._standaloneContainer);

        // Closing the menu (Done, Escape, double-click title, dragged off screen,
        // or replaced by another edit menu) is what leaves edit mode
        const originalDestroy = standaloneMenu.destroy.bind(standaloneMenu);
        standaloneMenu.destroy = (...args) => {
            if (this.editMenu === standaloneMenu) {
                this.stopEditing();
            }
            return originalDestroy(...args);
        };

        // The menu being up IS edit mode: from here the pin can be dragged
        this.startEditing(featureNode, view, standaloneMenu);

        // If focusOnText requested, focus and select the text input
        if (focusOnText) {
            // Wait for DOM to update, then focus the input
            setTimeout(() => {
                const input = textController.$input;
                if (input) {
                    input.focus();
                    input.select(); // Select all text for easy replacement
                }
            }, 0);
        }
    }

    /**
     * Enter edit mode for a pin: while its menu is up, the pin can be dragged
     * around in the view it was opened from. Mirrors CNodeSynthBuilding's edit
     * mode - document-level pointer listeners, gated on there being a pin to edit.
     * @param {CNodeFeatureMarker} featureNode - the pin being edited
     * @param {CNodeView3D} view - the view to drag it in
     * @param {GUI} menu - the pin's edit menu (closing it exits edit mode)
     */
    startEditing(featureNode, view, menu) {
        // Only one pin is edited at a time
        this.stopEditing();

        this.editingFeature = featureNode;
        this.editView = view ?? ViewMan.get("mainView", false);
        this.editMenu = menu;

        this.onPointerDownBound = (e) => this.onPointerDown(e);
        this.onPointerMoveBound = (e) => this.onPointerMove(e);
        this.onPointerUpBound = (e) => this.onPointerUp(e);
        this.onPointerCancelBound = () => this.endDrag();

        // CAPTURE phase, so a drag we take is entirely ours: the events never reach
        // the view's canvas. Otherwise CameraControls sees the press (before we can
        // disable it), has its state cleared by the first disabled move, and then
        // reads the drag's pointerup as a TAP - so a click within 300ms and 15px
        // double-tap-zooms the camera. Presses we don't take propagate as normal.
        document.addEventListener('pointerdown', this.onPointerDownBound, true);
        document.addEventListener('pointermove', this.onPointerMoveBound, true);
        document.addEventListener('pointerup', this.onPointerUpBound, true);
        // A cancelled pointer (touch/pen gesture taken over by the browser) never
        // sends pointerup, and would otherwise leave the drag - and the disabled
        // camera controls - stuck on
        document.addEventListener('pointercancel', this.onPointerCancelBound, true);
    }

    /**
     * Leave edit mode, undoing everything startEditing set up.
     * Safe to call when not editing.
     */
    stopEditing() {
        if (!this.editingFeature) return;

        this.endDrag();

        document.removeEventListener('pointerdown', this.onPointerDownBound, true);
        document.removeEventListener('pointermove', this.onPointerMoveBound, true);
        document.removeEventListener('pointerup', this.onPointerUpBound, true);
        document.removeEventListener('pointercancel', this.onPointerCancelBound, true);

        this.setHoverCursor(false);

        this.editingFeature = null;
        this.editMenu = null;
        this.editView = null;
        this.editReadout = null;
    }

    /**
     * Fill the menu's read-only location rows from the pin's current position.
     * Called on every drag move so the numbers track the pin.
     */
    updateEditReadout(featureNode = this.editingFeature) {
        const readout = this.editReadout;
        if (!readout || !featureNode || !featureNode.lla) return;

        const altHAE = featureNode.lla.alt;
        const geoidOffset = meanSeaLevelOffset(featureNode.lla.lat, featureNode.lla.lon);

        readout.lat = featureNode.lla.lat.toFixed(6);
        readout.lon = featureNode.lla.lon.toFixed(6);
        readout.altMSL = (altHAE - geoidOffset).toFixed(2);
        readout.altHAE = `${altHAE.toFixed(2)} (${geoidOffset.toFixed(2)})`;
    }

    /**
     * Move a pin to a new LLA (used by the drag undo/redo actions, which have to
     * look the pin up by id in case it was recreated in between)
     */
    setFeatureLLA(id, lla) {
        const featureNode = this.get(id, false);
        if (!featureNode || !featureNode.lla) return;

        featureNode.lla.lat = lla.lat;
        featureNode.lla.lon = lla.lon;
        featureNode.lla.alt = lla.alt;
        featureNode.recalculate(0);

        if (this.editingFeature === featureNode) {
            this.updateEditReadout();
        }

        setRenderOne(true);
    }

    // Show the "move" cursor while the pin under the mouse can be grabbed
    setHoverCursor(hovering) {
        if (hovering === this.hoveringFeature) return;
        this.hoveringFeature = hovering;
        document.body.style.cursor = hovering ? 'move' : 'default';
    }

    /**
     * Start dragging the pin, if the press is on it.
     */
    onPointerDown(event) {
        if (!this.editingFeature) return;
        if (event.button !== 0) return; // Only left mouse button

        // Clicks on a GUI element belong to the menu, not the pin
        let target = event.target;
        while (target) {
            if (target.classList && target.classList.contains('lil-gui')) {
                return;
            }
            target = target.parentElement;
        }

        const view = this.editView;
        if (!view || !view.camera || !mouseInViewOnly(view, event.clientX, event.clientY)) return;

        const featureNode = this.editingFeature;
        if (this.screenDistanceToFeature(featureNode, view, event.clientX, event.clientY) > FEATURE_PICK_RADIUS) {
            return;
        }

        // Grab offset from the arrow base, so grabbing the label (which floats
        // arrowLength pixels above the base) doesn't snap the pin to the cursor
        const points = this.featureScreenPoints(featureNode, view);
        if (points.length === 0) return;
        this.dragGrabOffset = {
            x: event.clientX - points[0].x,
            y: event.clientY - points[0].y,
        };

        this.dragStartLLA = {...featureNode.lla};
        this.isDragging = true;

        this.setHoverCursor(true);

        // Disable camera controls while dragging
        if (view.controls) {
            view.controls.enabled = false;
        }

        event.stopPropagation();
        event.preventDefault();

        // Capture the pointer, so a release OUTSIDE the browser window still comes
        // back to us - without it that pointerup is never delivered and the drag (and
        // the disabled camera controls) would stay stuck on. LAST, and guarded:
        // setPointerCapture throws on a pointer the browser doesn't consider active,
        // and that must not take the rest of the drag setup down with it.
        try {
            view.canvas.setPointerCapture(event.pointerId);
            this.dragPointerId = event.pointerId;
        } catch (e) { /* no capture - the buttons===0 guard in onPointerMove covers it */ }
    }

    /**
     * Drag the pin over the ground, or just update the hover cursor.
     */
    onPointerMove(event) {
        if (!this.editingFeature) return;

        const view = this.editView;
        if (!view || !view.camera) return;

        if (!this.isDragging) {
            // Hover feedback: "move" cursor when the pin can be grabbed
            const overFeature = mouseInViewOnly(view, event.clientX, event.clientY)
                && this.screenDistanceToFeature(this.editingFeature, view, event.clientX, event.clientY) <= FEATURE_PICK_RADIUS;
            this.setHoverCursor(overFeature);
            return;
        }

        // The button was released somewhere we never heard about (the same guard
        // CameraControls uses) - stop dragging rather than following the bare cursor
        if (event.buttons === 0) {
            this.endDrag();
            return;
        }

        const featureNode = this.editingFeature;

        // Cast at where the pin's BASE should end up, not at the cursor itself
        const baseX = event.clientX - this.dragGrabOffset.x;
        const baseY = event.clientY - this.dragGrabOffset.y;
        this.raycaster.setFromCamera(screenToNDC(view, baseX, baseY), view.camera);

        const ground = raycastLocalGround(this.raycaster, view.camera);
        if (ground && ground.point) {
            const lla = ECEFToLLAVD_radii(ground.point);
            featureNode.lla.lat = lla.x;
            featureNode.lla.lon = lla.y;
            // The pin lands ON the surface under the cursor, exactly as if it had been
            // dropped there. alt 0 is the "conform to the ground" sentinel, so leave
            // it alone. isTerrain means a real rendered surface was hit (terrain mesh
            // OR a Google 3D-tile roof), so its own height puts the pin under the
            // cursor; when it is false the hit is raycastLocalGround's ellipsoid-sphere
            // fallback, which sits hundreds of metres off the drawn ground, so take the
            // height from the elevation map instead.
            if (featureNode.lla.alt !== 0) {
                featureNode.lla.alt = ground.isTerrain
                    ? lla.z
                    : ECEFToLLAVD_radii(getPointBelowLL(lla.x, lla.y)).z;
            }

            featureNode.recalculate(0);
            this.updateEditReadout();
            setRenderOne(true);
        }

        event.stopPropagation();
        event.preventDefault();
    }

    /**
     * Finish the drag, and record it for undo
     */
    onPointerUp(event) {
        if (!this.isDragging) return;

        // The press was ours, so the release is too - see startEditing
        event.stopPropagation();
        event.preventDefault();

        const featureNode = this.editingFeature;
        const before = this.dragStartLLA;
        const after = featureNode ? {...featureNode.lla} : null;

        this.endDrag();

        if (featureNode && before && after && UndoManager
            && (before.lat !== after.lat || before.lon !== after.lon || before.alt !== after.alt)) {
            const id = featureNode.id;
            UndoManager.add({
                undo: () => {
                    this.setFeatureLLA(id, before);
                },
                redo: () => {
                    this.setFeatureLLA(id, after);
                },
                description: `Move pin "${featureNode.text || id}"`
            });
        }
    }

    // Stop any in-progress drag and give the camera back its controls
    endDrag() {
        if (!this.isDragging) return;

        this.isDragging = false;
        this.dragStartLLA = null;

        const view = this.editView;

        if (this.dragPointerId !== undefined) {
            // Only the capturing element can release, and it may already have lost the
            // capture (pointercancel), which throws
            try {
                view.canvas.releasePointerCapture(this.dragPointerId);
            } catch (e) { /* capture already gone */ }
            this.dragPointerId = undefined;
        }

        if (view && view.controls) {
            view.controls.enabled = true;
        }
    }
}

// Export a global singleton instance
export const FeatureManager = new CFeatureManager();