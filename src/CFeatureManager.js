import {CManager} from "./CManager";
import {CNodeFeatureMarker} from "./nodes/CNodeLabels3D";
import {Globals, NodeMan} from "./Globals";
import {Vector3} from "three";

/**
 * CFeatureManager
 * Manages geographic feature markers (labels with arrows pointing to locations)
 * Similar to TrackManager, but for static geographic features
 */
class CFeatureManager extends CManager {
    constructor() {
        super();
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
            const featureNode = this.get(id);
            
            // Dispose the node (removes arrow, sprite, etc.)
            if (featureNode.dispose) {
                featureNode.dispose();
            }
            
            // Remove from NodeMan if it's registered there
            if (NodeMan.exists(id)) {
                NodeMan.unlinkDisposeRemove(id);
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
        
        const threshold = 30; // pixels
        let closestFeature = null;
        let closestDistance = threshold;
        
        // Iterate through all features and check screen-space distance
        this.iterate((id, featureNode) => {
            if (!featureNode.featurePosition || !featureNode.group.visible) return;
            
            // Check both the arrow (at featurePosition) and the label (at arrowLength pixels above)
            const positions = [
                featureNode.featurePosition,  // Arrow base
                view.offsetScreenPixels(featureNode.featurePosition.clone(), 0, featureNode.arrowLength)  // Label position
            ];
            
            for (const pos3D of positions) {
                // Project to screen space
                const screenPos = new Vector3(pos3D.x, pos3D.y, pos3D.z);
                screenPos.project(view.camera);
                
                // Skip if behind camera
                if (screenPos.z > 1) continue;
                
                // Convert from normalized device coordinates (-1 to 1) to screen pixels
                const screenX = (screenPos.x * 0.5 + 0.5) * view.widthPx + view.leftPx;
                const screenY = (1 - (screenPos.y * 0.5 + 0.5)) * view.heightPx + view.topPx;
                
                // Calculate distance from mouse to projected point
                const dx = mouseX - screenX;
                const dy = mouseY - screenY;
                const distance = Math.sqrt(dx * dx + dy * dy);
                
                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestFeature = featureNode;
                }
            }
        });
        
        // If we found a feature, show the edit menu
        if (closestFeature) {
            this.showFeatureEditMenu(closestFeature, mouseX, mouseY);
            return true;
        }
        
        return false;
    }

    /**
     * Show the edit menu for a feature marker
     * @param {CNodeFeatureMarker} featureNode - The feature to edit
     * @param {number} clientX - Screen X coordinate for menu placement
     * @param {number} clientY - Screen Y coordinate for menu placement
     * @param {boolean} focusOnText - Whether to focus on the text field (default: false)
     */
    showFeatureEditMenu(featureNode, clientX, clientY, focusOnText = false) {
        console.log(`Editing feature: ${featureNode.id}`);
        
        // Create an edit menu for the feature
        const menuTitle = `Feature: ${featureNode.text || "(blank)"}`;
        const standaloneMenu = Globals.menuBar.createStandaloneMenu(menuTitle, clientX, clientY, true);
        
        // If menu creation was blocked (persistent menu is open), return early
        if (!standaloneMenu) {
            return;
        }
        
        // Add editable text field
        const editableData = {
            text: featureNode.text
        };
        
        const textController = standaloneMenu.add(editableData, 'text')
            .name('Label Text')
            .listen()
            .onChange((value) => {
                // Update the feature's text
                featureNode.text = value;
                featureNode.sprite.text = value;
                // Update the menu title
                standaloneMenu.title(value ? `Feature: ${value}` : `Feature: (blank)`);
            });
        
        // Add location info (read-only)
        if (featureNode.lla) {
            standaloneMenu.add({lat: featureNode.lla.lat.toFixed(6)}, 'lat').name('Latitude').listen().disable();
            standaloneMenu.add({lon: featureNode.lla.lon.toFixed(6)}, 'lon').name('Longitude').listen().disable();
            standaloneMenu.add({alt: featureNode.lla.alt.toFixed(2)}, 'alt').name('Altitude (m)').listen().disable();
        }
        
        // Add arrow length slider
        standaloneMenu.add(featureNode, 'arrowLength', 0, 300, 1)
            .name('Arrow Length')
            .listen()
            .onChange((value) => {
                // Update the offset.y to match the new arrow length
                // (offset is a Vector2, not individual properties)
                featureNode.offset.y = value;
            });
        
        // Add arrow color picker
        standaloneMenu.addColor(featureNode, 'arrowColor')
            .name('Arrow Color')
            .listen();
        
        // Add text color picker
        standaloneMenu.addColor(featureNode, 'textColor')
            .name('Text Color')
            .listen()
            .onChange((value) => {
                // Convert hex number to CSS color string for the sprite
                const hexString = '#' + value.toString(16).padStart(6, '0');
                featureNode.sprite.color = hexString;
            });
        
        // Add Delete button
        const deleteObj = {
            deleteFeature: () => {
                // Confirm before deleting
                const featureName = featureNode.text || 'this feature';
                if (confirm(`Delete "${featureName}"?`)) {
                    // Remove the feature
                    this.removeFeature(featureNode.id);
                    // Close the menu
                    standaloneMenu.destroy();
                }
            }
        };
        standaloneMenu.add(deleteObj, 'deleteFeature')
            .name('🗑️ Delete Feature')
            .setLabelColor('#ff4444');
        
        // Open the menu
        standaloneMenu.open();
        
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
}

// Export a global singleton instance
export const FeatureManager = new CFeatureManager();