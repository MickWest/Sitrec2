/**
 * GUI mirroring: clone guiMenus folders into draggable standalone windows.
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
import {GlobalScene} from "./LocalFrame";
import {refreshLabelsAfterLoading} from "./nodes/CNodeLabels3D";
import {assert} from "./assert";
import {getShortURL} from "./urlUtils";
import {CNode3DObject, ModelAliases} from "./nodes/CNode3DObject";
import {UpdateHUD} from "./JetStuff";
import {degrees, getDateTimeFilename} from "./utils";
import {ViewMan} from "./CViewManager";
import {EventManager} from "./CEventManager";
import {isAdmin, SITREC_APP, SITREC_SERVER} from "./configUtils";
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
import {parseObjectInput as parseObjectInputUtil} from "./utils/parseObjectInput";
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
import {CNodeFloodSim} from "./nodes/CNodeFloodSim";
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

export const mirrorMethods = {
    /**
     * Mirror a GUI folder to create a standalone menu with all the same functions
     * @param {string} sourceFolderName - The name of the source folder in guiMenus to mirror
     * @param {string} menuTitle - The title for the new standalone menu
     * @param {number} x - X position for the standalone menu
     * @param {number} y - Y position for the standalone menu
     * @returns {GUI} The created standalone menu
     */
    mirrorGUIFolder(sourceFolderName, menuTitle, x = 200, y = 200) {
        // Check if the source folder exists
        if (!guiMenus[sourceFolderName]) {
            showError(`Source folder '${sourceFolderName}' not found in guiMenus`);
            return null;
        }

        const sourceFolder = guiMenus[sourceFolderName];

        // Create the standalone menu
        const standaloneMenu = Globals.menuBar.createStandaloneMenu(menuTitle, x, y);

        // Set up dynamic mirroring
        this.setupDynamicMirroring(sourceFolder, standaloneMenu);

        // Open the menu by default
        standaloneMenu.open();

        console.log(`Mirrored GUI folder '${sourceFolderName}' to standalone menu '${menuTitle}'`);

        // Add a method to manually refresh the mirror
        standaloneMenu.refreshMirror = () => {
            this.updateMirror(standaloneMenu);
        };

        return standaloneMenu;
    },

    /**
     * Set up dynamic mirroring that automatically updates when the source changes
     * @param {GUI} sourceFolder - Source GUI folder to mirror
     * @param {GUI} standaloneMenu - Target standalone menu
     */
    setupDynamicMirroring(sourceFolder, standaloneMenu) {
        // console.log('setupDynamicMirroring called for sourceFolder:', sourceFolder._title || 'root');

        // Store reference to source for updates
        standaloneMenu._mirrorSource = sourceFolder;
        standaloneMenu._lastMirrorState = null;

        // Initial mirror
        this.updateMirror(standaloneMenu);

        // Try event-based approach first, fall back to polling if needed
        // console.log('About to call setupEventBasedMirroring');
        if (this.setupEventBasedMirroring(sourceFolder, standaloneMenu)) {
            // console.log('Using event-based mirroring for', standaloneMenu._title);
        } else {
            // Fallback to periodic checking for changes
            // console.log('Using polling-based mirroring for', standaloneMenu._title);
            const checkInterval = 100; // Check every 100ms
            standaloneMenu._mirrorUpdateInterval = setInterval(() => {
                this.updateMirror(standaloneMenu);
            }, checkInterval);
        }

        // Clean up when menu is destroyed
        const originalDestroy = standaloneMenu.destroy.bind(standaloneMenu);
        standaloneMenu.destroy = (...args) => {
            if (standaloneMenu._mirrorUpdateInterval) {
                clearInterval(standaloneMenu._mirrorUpdateInterval);
                standaloneMenu._mirrorUpdateInterval = null;
            }
            if (standaloneMenu._mirrorEventCleanup) {
                standaloneMenu._mirrorEventCleanup();
                standaloneMenu._mirrorEventCleanup = null;
            }
            originalDestroy(...args);
        };
    },

    /**
     * Set up event-based mirroring by hooking into GUI methods
     * @param {GUI} sourceFolder - Source GUI folder to monitor
     * @param {GUI} standaloneMenu - Target standalone menu to update
     * @returns {boolean} True if event-based mirroring was successfully set up
     */
    setupEventBasedMirroring(sourceFolder, standaloneMenu) {
        try {
            // Store all hooked methods for cleanup
            const allHookedMethods = [];

            // Recursively hook into all folders and sub-folders
            this.hookFolderRecursively(sourceFolder, standaloneMenu, allHookedMethods);

            // Store cleanup function
            standaloneMenu._mirrorEventCleanup = () => {
                // Restore all original methods
                allHookedMethods.forEach(({ folder, methodName, originalMethod }) => {
                    folder[methodName] = originalMethod;
                });
            };

            return true;
        } catch (error) {
            console.warn('Failed to set up event-based mirroring:', error);
            return false;
        }
    },

    /**
     * Recursively hook into a folder and all its sub-folders
     * @param {GUI} folder - The folder to hook into
     * @param {GUI} standaloneMenu - Target standalone menu to update
     * @param {Array} allHookedMethods - Array to store hooked methods for cleanup
     */
    hookFolderRecursively(folder, standaloneMenu, allHookedMethods) {
        // console.log('hookFolderRecursively called for folder:', folder._title || 'root', 'controllers:', folder.controllers.length);

        const methodsToHook = ['add', 'addColor', 'addFolder', 'remove'];

        // Hook into GUI methods that modify the structure
        methodsToHook.forEach(methodName => {
            if (typeof folder[methodName] === 'function') {
                const originalMethod = folder[methodName].bind(folder);

                // Store for cleanup
                allHookedMethods.push({ folder, methodName, originalMethod });

                folder[methodName] = (...args) => {
                    const result = originalMethod(...args);

                    // If we just added a folder, hook into it too
                    if (methodName === 'addFolder' && result) {
                        setTimeout(() => {
                            this.hookFolderRecursively(result, standaloneMenu, allHookedMethods);
                        }, 0);
                    }

                    // If we just added a controller, hook its destroy method and visibility methods
                    if ((methodName === 'add' || methodName === 'addColor') && result && typeof result.destroy === 'function') {
                        if (folder._controllerHookFunction) {
                            folder._controllerHookFunction(result);
                        }

                        // Also hook visibility methods for the new controller
                        setTimeout(() => {
                            this.hookSingleControllerVisibility(result, standaloneMenu, allHookedMethods);
                        }, 0);
                    }

                    // Defer update to next tick to allow GUI to stabilize
                    setTimeout(() => this.updateMirror(standaloneMenu), 0);
                    return result;
                };
            }
        });

        // Hook into controller destroy method for any existing controllers
        // console.log('About to call hookControllerDestroy for folder:', folder._title || 'root');
        this.hookControllerDestroy(folder, standaloneMenu);

        // Hook into visibility methods for existing controllers
        this.hookControllerVisibility(folder, standaloneMenu, allHookedMethods);

        // Hook into visibility methods for this folder
        this.hookFolderVisibility(folder, standaloneMenu, allHookedMethods);

        // Recursively hook into existing sub-folders
        // console.log('Processing sub-folders, count:', folder.folders.length);
        folder.folders.forEach(subfolder => {
            this.hookFolderRecursively(subfolder, standaloneMenu, allHookedMethods);
        });
    },

    /**
     * Hook into controller destroy methods to detect when controllers are removed
     * @param {GUI} sourceFolder - Source GUI folder
     * @param {GUI} standaloneMenu - Target standalone menu
     */
    hookControllerDestroy(sourceFolder, standaloneMenu) {
        const hookController = (controller) => {
            if (controller._mirrorHooked) return; // Already hooked
            controller._mirrorHooked = true;

            const originalDestroy = controller.destroy.bind(controller);
            controller.destroy = () => {
                originalDestroy();
                // Defer update to next tick
                setTimeout(() => this.updateMirror(standaloneMenu), 0);
            };
        };

        // Hook existing controllers in this folder
        // console.log('hookControllerDestroy: sourceFolder.controllers.length =', sourceFolder.controllers.length);
        sourceFolder.controllers.forEach((controller, index) => {
            // console.log(`Hooking controller ${index}:`, controller);
            hookController(controller);
        });

        // Store the hook function so the recursive method can use it for new controllers
        sourceFolder._controllerHookFunction = hookController;
    },

    /**
     * Hook into controller visibility methods to detect hide/show changes
     * @param {GUI} sourceFolder - The folder containing controllers to hook
     * @param {GUI} standaloneMenu - The mirrored menu to update
     * @param {Array} allHookedMethods - Array to store hooked methods for cleanup
     */
    hookControllerVisibility(sourceFolder, standaloneMenu, allHookedMethods) {
        sourceFolder.controllers.forEach(controller => {
            // Hook show method
            if (typeof controller.show === 'function') {
                const originalShow = controller.show.bind(controller);
                allHookedMethods.push({ folder: controller, methodName: 'show', originalMethod: originalShow });

                controller.show = (show) => {
                    const result = originalShow(show);
                    setTimeout(() => this.updateMirror(standaloneMenu), 0);
                    return result;
                };
            }
        });
    },

    /**
     * Hook into visibility methods for a single controller
     * @param {Controller} controller - The controller to hook
     * @param {GUI} standaloneMenu - The mirrored menu to update
     * @param {Array} allHookedMethods - Array to store hooked methods for cleanup
     */
    hookSingleControllerVisibility(controller, standaloneMenu, allHookedMethods) {
        // Hook show method
        if (typeof controller.show === 'function') {
            const originalShow = controller.show.bind(controller);
            allHookedMethods.push({ folder: controller, methodName: 'show', originalMethod: originalShow });

            controller.show = (show) => {
                const result = originalShow(show);
                setTimeout(() => this.updateMirror(standaloneMenu), 0);
                return result;
            };
        }
    },

    /**
     * Hook into folder visibility methods to detect hide/show changes
     * @param {GUI} folder - The folder to hook visibility methods for
     * @param {GUI} standaloneMenu - The mirrored menu to update
     * @param {Array} allHookedMethods - Array to store hooked methods for cleanup
     */
    hookFolderVisibility(folder, standaloneMenu, allHookedMethods) {

        // Hook show method
        if (typeof folder.show === 'function') {
            const originalShow = folder.show.bind(folder);
            allHookedMethods.push({ folder, methodName: 'show', originalMethod: originalShow });

            folder.show = (show = true) => {
                const result = originalShow(show);
                setTimeout(() => this.updateMirror(standaloneMenu), 0);
                return result;
            };
        }

        // we don't hook the hide method
        // because hide calls show(false)
        // so we only need to hook the show method, and ensure the parameter is passed
        // (and has the same default value of true)

    },

    /**
     * Update the mirror to match the current state of the source
     * @param {GUI} standaloneMenu - The mirrored menu to update
     */
    updateMirror(standaloneMenu) {
        const sourceFolder = standaloneMenu._mirrorSource;
        if (!sourceFolder) return;

        // Create a signature of the current source state
        const currentState = this.createGUISignature(sourceFolder);

        // Compare with last known state
        if (standaloneMenu._lastMirrorState !== currentState) {
            // State has changed, rebuild the mirror
            this.rebuildMirror(sourceFolder, standaloneMenu);
            standaloneMenu._lastMirrorState = currentState;
        }
    },

    /**
     * Create a signature string representing the current state of a GUI folder
     * i.e. what items it has in it, and what their visiblity state is
     * it does NOT include values, only structure and visibility states.
     * @param {GUI} folder - The GUI folder to create a signature for
     * @returns {string} A signature representing the folder's structure
     */
    createGUISignature(folder) {
        const parts = [];

        // Add controller signatures
        folder.controllers.forEach(controller => {
            const name = controller._name || 'unnamed';
            const type = controller.constructor.name;
            const visible = controller._hidden ? 'hidden' : 'visible';
            parts.push(`ctrl:${name}:${type}:${visible}`);
        });

        // Add folder signatures recursively
        folder.folders.forEach(subfolder => {
            const name = subfolder._title || 'unnamed';
            const open = subfolder._closed ? 'closed' : 'open';
            const visible = subfolder._hidden ? 'hidden' : 'visible';
            const subSignature = this.createGUISignature(subfolder);
            parts.push(`folder:${name}:${open}:${visible}:${subSignature}`);
        });

        const sig = parts.join('|');
        return sig;
    },

    /**
     * Completely rebuild the mirror to match the source
     * @param {GUI} sourceFolder - Source GUI folder
     * @param {GUI} standaloneMenu - Target standalone menu to rebuild
     */
    rebuildMirror(sourceFolder, standaloneMenu) {
        // Clear existing controllers and folders
        this.clearMirror(standaloneMenu);

        // Rebuild from source
        this.mirrorGUIControls(sourceFolder, standaloneMenu);
    },

    /**
     * Clear all controllers and folders from a GUI menu
     * @param {GUI} menu - The GUI menu to clear
     */
    clearMirror(menu) {
        // Remove all controllers
        while (menu.controllers.length > 0) {
            const controller = menu.controllers[menu.controllers.length - 1];
            controller.destroy();
        }

        // Remove all folders
        while (menu.folders.length > 0) {
            const folder = menu.folders[menu.folders.length - 1];
            folder.destroy();
        }
    },

    /**
     * Recursively mirror GUI controls from source to target
     * @param {GUI} source - Source GUI folder
     * @param {GUI} target - Target GUI folder
     */
    mirrorGUIControls(source, target) {
        // Get all child elements (controllers and folders) in DOM order
        const childElements = this.getGUIChildrenInOrder(source);

        // Process each child element in the order they appear in the DOM
        childElements.forEach(child => {
            if (child.type === 'controller') {
                this.mirrorController(child.element, target);
            } else if (child.type === 'folder') {
                this.mirrorFolder(child.element, target);
            }
        });
    },

    /**
     * Get all GUI children (controllers and folders) in their creation order
     * This uses a heuristic approach to maintain the visual order as much as possible
     * @param {GUI} gui - The GUI to get children from
     * @returns {Array} Array of objects with {type: 'controller'|'folder', element: controller|folder}
     */
    getGUIChildrenInOrder(gui) {
        const children = [];

        try {
            // Try to use DOM order first
            const domBasedOrder = this.getDOMBasedOrder(gui);
            if (domBasedOrder.length === gui.controllers.length + gui.folders.length) {
                return domBasedOrder;
            }

            // Fallback: Use a heuristic that puts folders first if they have specific names
            // This handles the common case where Material folder should appear first
            return this.getHeuristicOrder(gui);

        } catch (error) {
            console.warn('Error in ordering, using fallback:', error);
            return this.getFallbackChildrenOrder(gui);
        }
    },

    /**
     * Try to get children in DOM order
     * @param {GUI} gui - The GUI to get children from
     * @returns {Array} Array of objects with {type: 'controller'|'folder', element: controller|folder}
     */
    getDOMBasedOrder(gui) {
        const children = [];

        // Get the DOM element of the GUI
        const domElement = gui.domElement;
        if (!domElement) {
            return [];
        }

        // In lil-gui, the actual children are in the $children container
        // Try to find the children container
        let childrenContainer = gui.$children;
        if (!childrenContainer) {
            // Fallback: look for the children container in the DOM
            childrenContainer = domElement.querySelector('.children');
            if (!childrenContainer) {
                // Last resort: use the domElement itself
                childrenContainer = domElement;
            }
        }

        // Get all child elements in DOM order from the children container
        const childNodes = Array.from(childrenContainer.children);

        childNodes.forEach(childNode => {
            // Check if this DOM element corresponds to a controller
            const controller = gui.controllers.find(ctrl => {
                return ctrl.domElement === childNode ||
                    (ctrl.domElement && ctrl.domElement.parentElement === childNode) ||
                    (ctrl.domElement && childNode.contains && childNode.contains(ctrl.domElement));
            });

            if (controller) {
                children.push({ type: 'controller', element: controller });
                return;
            }

            // Check if this DOM element corresponds to a folder
            const folder = gui.folders.find(fld => {
                return fld.domElement === childNode ||
                    (fld.domElement && fld.domElement.parentElement === childNode) ||
                    (fld.domElement && childNode.contains && childNode.contains(fld.domElement));
            });

            if (folder) {
                children.push({ type: 'folder', element: folder });
            }
        });

        return children;
    },

    /**
     * Use heuristics to determine a reasonable order
     * @param {GUI} gui - The GUI to get children from
     * @returns {Array} Array of objects with {type: 'controller'|'folder', element: controller|folder}
     */
    getHeuristicOrder(gui) {
        const children = [];

        // Special handling for common folder names that should appear first
        const priorityFolderNames = ['Material', 'Geometry', 'Transform', 'Animation'];

        // Add priority folders first
        priorityFolderNames.forEach(priorityName => {
            const folder = gui.folders.find(f => f._title === priorityName);
            if (folder) {
                children.push({ type: 'folder', element: folder });
            }
        });

        // Add controllers
        gui.controllers.forEach(controller => {
            children.push({ type: 'controller', element: controller });
        });

        // Add remaining folders
        gui.folders.forEach(folder => {
            // Skip if already added as priority folder
            if (!priorityFolderNames.includes(folder._title)) {
                children.push({ type: 'folder', element: folder });
            }
        });

        return children;
    },

    /**
     * Fallback method to get children in the original order (controllers first, then folders)
     * @param {GUI} gui - The GUI to get children from
     * @returns {Array} Array of objects with {type: 'controller'|'folder', element: controller|folder}
     */
    getFallbackChildrenOrder(gui) {
        const children = [];

        // Add all controllers first
        gui.controllers.forEach(controller => {
            children.push({ type: 'controller', element: controller });
        });

        // Add all folders after
        gui.folders.forEach(folder => {
            children.push({ type: 'folder', element: folder });
        });

        return children;
    },

    /**
     * Mirror a single controller
     * @param {Controller} controller - The controller to mirror
     * @param {GUI} target - The target GUI to add the mirrored controller to
     */
    mirrorController(controller, target) {
        try {
            // Get the controller properties
            const object = controller.object;
            const property = controller.property;
            const name = controller._name;

            // Create the mirrored controller based on type
            let mirroredController;

            if (controller.constructor.name === 'ColorController') {
                mirroredController = target.addColor(object, property);
            } else if (controller.constructor.name === 'OptionController') {
                // For dropdown/select controllers, reconstruct the {label: value} map
                // so lil-gui uses _names as display labels and _values as stored values.
                // Passing just _values (an array) would lose the human-readable labels.
                const optionsMap = {};
                for (let i = 0; i < controller._names.length; i++) {
                    optionsMap[controller._names[i]] = controller._values[i];
                }
                mirroredController = target.add(object, property, optionsMap);
            } else if (controller.constructor.name === 'NumberController') {
                // For numeric controllers with min/max
                if (controller._min !== undefined && controller._max !== undefined) {
                    mirroredController = target.add(object, property, controller._min, controller._max, controller._step);
                } else {
                    mirroredController = target.add(object, property);
                }
            } else {
                // For boolean and other basic controllers
                mirroredController = target.add(object, property);
            }

            // Copy controller properties
            if (mirroredController) {
                mirroredController.name(name);

                // Copy tooltip if it exists
                if (controller._tooltip) {
                    mirroredController.tooltip(controller._tooltip);
                }

                // Copy elastic properties for numeric controllers
                if (controller._elastic && mirroredController.elastic) {
                    mirroredController.elastic(controller._elastic.max, controller._elastic.maxMax, controller._elastic.allowNegative);
                }

                // Copy unit type metadata for numeric controllers with unit conversion
                // We copy the properties directly instead of calling setUnitType() because:
                // 1. The name already includes the unit suffix (copied above)
                // 2. The proxy already stores values in display units (no conversion needed)
                // 3. Calling setUnitType() would double-convert and double-suffix
                if (controller._unitType) {
                    mirroredController._unitType = controller._unitType;
                    // Copy the SI reference values so getSIValue()/setSIValue() work correctly
                    if (controller._originalMinSI !== undefined) {
                        mirroredController._originalMinSI = controller._originalMinSI;
                        mirroredController._originalMaxSI = controller._originalMaxSI;
                        mirroredController._originalStepSI = controller._originalStepSI;
                    }
                    // Copy original name for unit change updates
                    if (controller._originalName) {
                        mirroredController._originalName = controller._originalName;
                    }
                }

                // Set up bidirectional sync by wrapping onChange handlers
                // lil-gui's listen() doesn't reliably sync between two controllers pointing to same data
                // So we explicitly update the other controller when either one changes

                const originalOnChange = controller._onChange;

                // When SOURCE changes, update mirrored controller's display
                const sourceOnChange = (value) => {
                    if (originalOnChange) originalOnChange(value);
                    mirroredController.updateDisplay();
                };
                controller.onChange(sourceOnChange);

                // When MIRRORED changes, call original handler and update source display
                mirroredController.onChange((value) => {
                    if (originalOnChange) originalOnChange(value);
                    controller.updateDisplay();
                });

                // Set up bidirectional sync for onFinishChange handlers
                // This is critical for fields like trackStartTime that parse input on finish
                const originalOnFinishChange = controller._onFinishChange;
                if (originalOnFinishChange) {
                    // When SOURCE finishes editing, update mirrored controller's display
                    controller.onFinishChange((value) => {
                        originalOnFinishChange(value);
                        mirroredController.updateDisplay();
                    });

                    // When MIRRORED finishes editing, call original handler and update source display
                    mirroredController.onFinishChange((value) => {
                        originalOnFinishChange(value);
                        controller.updateDisplay();
                    });
                }

                // Store bidirectional mirror references for setSIValue sync
                if (!controller._mirrorControllers) controller._mirrorControllers = [];
                if (!mirroredController._mirrorControllers) mirroredController._mirrorControllers = [];
                controller._mirrorControllers.push(mirroredController);
                mirroredController._mirrorControllers.push(controller);

                // Copy visibility state
                mirroredController.show(!controller._hidden);

                // Still enable listen() for any external changes
                controller.listen();
                mirroredController.listen();
            }
        } catch (error) {
            console.warn(`Failed to mirror controller '${controller._name}':`, error);
        }
    },

    /**
     * Mirror a single folder
     * @param {GUI} folder - The folder to mirror
     * @param {GUI} target - The target GUI to add the mirrored folder to
     */
    mirrorFolder(folder, target) {
        const folderName = folder._title;
        const mirroredFolder = target.addFolder(folderName);

        // Recursively mirror the folder contents
        this.mirrorGUIControls(folder, mirroredFolder);

        // Always open mirrored folders for better visibility
        mirroredFolder.open();

        // Copy folder visibility state
        mirroredFolder.show(!folder._hidden);
    },

    /**
     * Example of mirroring the Flow Orbs menu with dynamic updates
     */
    setupFlowOrbsMirrorExample() {
        // First check if there are any Flow Orbs nodes in the scene
        let flowOrbsNode = null;
        NodeMan.iterate((id, node) => {
            if (node.constructor.name === 'CNodeFlowOrbs' || node.constructor.name === 'CNodeSpriteGroup') {
                if (node.gui && node.gui._title === 'Flow Orbs') {
                    flowOrbsNode = node;
                    return false; // Break iteration
                }
            }
        });

        if (!flowOrbsNode) {
            console.log("No Flow Orbs node found - creating example mirror of effects menu instead");
            // Mirror the effects menu as an example with dynamic updates
            this.mirroredFlowOrbsMenu = this.mirrorGUIFolder("effects", "Mirrored Effects", 400, 200);
            return;
        }

        // Create a standalone menu that mirrors the Flow Orbs controls with dynamic updates
        const standaloneMenu = Globals.menuBar.createStandaloneMenu("Mirrored Flow Orbs", 400, 200);

        // Set up dynamic mirroring for the Flow Orbs GUI
        this.setupDynamicMirroring(flowOrbsNode.gui, standaloneMenu);

        // Store reference for potential cleanup
        this.mirroredFlowOrbsMenu = standaloneMenu;

        console.log("Created dynamically mirrored Flow Orbs menu");
    },

    /**
     * Create a dynamic mirror for any node's GUI
     * @param {string} nodeId - The ID of the node whose GUI to mirror
     * @param {string} menuTitle - Title for the mirrored menu
     * @param {number} x - X position for the menu
     * @param {number} y - Y position for the menu
     * @returns {GUI|null} The created mirrored menu or null if node not found
     */
    mirrorNodeGUI(nodeId, menuTitle, x = 200, y = 200) {
        const node = NodeMan.get(nodeId);
        if (!node || !node.gui) {
            showError(`Node '${nodeId}' not found or has no GUI`);
            return null;
        }

        // Create a standalone menu
        const standaloneMenu = Globals.menuBar.createStandaloneMenu(menuTitle, x, y);

        // Set up dynamic mirroring
        this.setupDynamicMirroring(node.gui, standaloneMenu);

        // Add a method to manually refresh the mirror
        standaloneMenu.refreshMirror = () => {
            this.updateMirror(standaloneMenu);
        };

        console.log(`Created dynamic mirror for node '${nodeId}' GUI`);
        return standaloneMenu;
    },

    /**
     * Global utility function to create dynamic mirrors
     * Can be called from console: CustomManager.createDynamicMirror('nodeId', 'Mirror Title')
     * @param {string} sourceType - Either 'menu' for guiMenus or 'node' for node GUI
     * @param {string} sourceName - Name of the menu in guiMenus or node ID
     * @param {string} title - Title for the mirrored menu
     * @param {number} x - X position
     * @param {number} y - Y position
     * @returns {GUI|null} The created mirrored menu
     */
    createDynamicMirror(sourceType, sourceName, title, x = 200, y = 200) {
        if (sourceType === 'menu') {
            return this.mirrorGUIFolder(sourceName, title, x, y);
        } else if (sourceType === 'node') {
            return this.mirrorNodeGUI(sourceName, title, x, y);
        } else {
            console.error(`Invalid source type '${sourceType}'. Use 'menu' or 'node'.`);
            return null;
        }
    },

    /**
     * Demo function to show how to mirror different GUI menus
     */
    showMirrorMenuDemo() {
        // Create a modal dialog showing available menus and how to mirror them
        const availableMenus = Object.keys(guiMenus);

        let message = "GUI Menu Mirroring Demo\n\n";
        message += "Available menus to mirror:\n";
        availableMenus.forEach(menuName => {
            message += `• ${menuName}\n`;
        });

        message += "\nExample usage:\n";
        message += "// Mirror the view menu to a standalone popup\n";
        message += "this.mirrorGUIFolder('view', 'My View Controls', 300, 300);\n\n";
        message += "// Mirror the objects menu\n";
        message += "this.mirrorGUIFolder('objects', 'Object Controls', 500, 100);\n\n";
        message += "The mirrored menu will have all the same controls and functionality as the original,\n";
        message += "but in a draggable standalone window.\n\n";
        message += "Would you like to create a demo mirror of the 'view' menu?";

        if (confirm(message)) {
            // Create a demo mirror of the view menu
            const demoMenu = this.mirrorGUIFolder("view", "Demo View Mirror", 500, 300);
            if (demoMenu) {
                alert("Demo mirror created! You can drag it around and use all the controls.\nCheck the console for more details.");
            }
        }
    },
};
