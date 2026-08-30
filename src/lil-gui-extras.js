// Helper functions for lil-gui
import GUI, {Controller, NumberController} from "./js/lil-gui.esm";
//import {updateSize} from "./JetStuff";
import {Globals, setMouseOverGUI, Units} from "./Globals";
import {Color} from "three";
import {assert} from "./assert";
import {ViewMan} from "./CViewManager";
import {getEnv, getEnvBool} from "./envUtils";
import Stats from "stats.js";
import {
    addMenuToCenterSidebar,
    addMenuToLeftSidebar,
    addMenuToRightSidebar,
    getCenterSidebar,
    getCenterSidebarAdjustment,
    getCenterSidebarMenuIndex,
    getLeftSidebar,
    getLeftSidebarMenuIndex,
    getRightSidebar,
    getRightSidebarMenuIndex,
    isInCenterSidebar,
    isInLeftSidebar,
    isInRightSidebar,
    removeMenuFromCenterSidebar,
    removeMenuFromLeftSidebar,
    removeMenuFromRightSidebar,
    toggleControlsVisibility
} from "./PageStructure";
import {getTextWidth} from "./lil-gui-slider-settings";
import {updateGUIRootListeners} from "./GUIRootRegistry";
import "./MenuMirror";      // installs Controller.shareAs/mirrorTo + GUI.addMirror/mirrorFolderFrom

// Issue with lil-gui, the OptionController options() method adds a
// _names array to the controller object, and a _values array
// When it's passed an object then these are value and keys, generated from the object
// but when it's an array, then BOTH _values and _names reference the original array
// meaning adding and removing options (below) will not work
// it will A) corrupt the original, and B) add everything twice
// Solution (patch) is to make a copy of the array

// add an option to a drop down menu
// note for usage with CNodeSwitch, optionName and optionValue will be the same
// as we use it as in index into the this.inputs object
// so adding and deleting also has to modify this.inputs (where "this" is a CNodeSwitch
export function addOptionToGUIMenu(controller, optionName, optionValue = optionName) {
    const index = controller._names.indexOf(optionName);
    if (index !== -1) {
        console.warn("Option " + optionName + "  already exists in controller, skipping re-add");
        return;
    }
    // Update internal arrays
    controller._values.push(optionValue);
    controller._names.push(optionName);

    // Create a new option element
    const $option = document.createElement('option');
    $option.textContent = optionName;
    $option.value = optionValue;

    // Append the new option to the select element
    controller.$select.appendChild($option);

    // Update the display (clear lil-gui's updateDisplay value-guard so the
    // rebuilt <select>'s selectedIndex re-syncs even when the value is unchanged)
    controller._lastDisplayedValue = undefined;
    controller.updateDisplay();

    // Notify menu bar to update visibility
    if (controller.parent) {
        controller.parent._notifyMenuBarChanged();
    }
}

// Same, but for removing an option
export function removeOptionFromGUIMenu(controller, optionName) {
    // Find the index of the option to be removed
    const index = controller._names.indexOf(optionName);
    if (index !== -1) {
        // Remove the option element
        controller.$select.removeChild(controller.$select.options[index]);

        // Update internal arrays
        controller._values.splice(index, 1);
        controller._names.splice(index, 1);

        // Update the display (clear the value-guard so the <select>'s
        // selectedIndex re-syncs after the option list shifted)
        controller._lastDisplayedValue = undefined;
        controller.updateDisplay();

        // Notify menu bar to update visibility
        if (controller.parent) {
            controller.parent._notifyMenuBarChanged();
        }
    } else {
        //        console.warn("Option "+ optionName +"  does not exist in controller, skipping remove");
    }
}

export function dumpGUIMenu(controller) {
    if (controller._names[0] === "Start Time") {
        console.log("Dumping GUI Menu")
        for (let i = 0; i < controller._names.length; i++) {
            console.log(i + ": " + controller._names[i] + " = " + controller._values[i])
        }
        // also dump the $select
        console.log(controller.$select)
    }
}

export function preventDoubleClicks(gui) {
    gui.domElement.addEventListener('dblclick', function (e) {
        e.stopPropagation();
    });
}

function isActiveElementTextInput() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    const type = el.type ? el.type.toLowerCase() : '';
    return tag === 'textarea' || (tag === 'input' && (type === 'text' || type === 'number'));
}

export function addGUIMouseTracking(gui) {
    gui.domElement.addEventListener('mouseenter', function (e) {
        setMouseOverGUI(true);
    });

    gui.domElement.addEventListener('mouseleave', function (e) {
        setMouseOverGUI(false);
        if (document.activeElement && gui.domElement.contains(document.activeElement) && !isActiveElementTextInput()) {
            document.activeElement.blur();
        }
    });
}

// Extend the GUI prototype to add a method for getting the folder with given title
//
GUI.prototype.getFolder = function (title) {
    // Find the child GUI by its stable lookup id (set via `folder._lookupId` when the
    // displayed title differs from the id callers search by — e.g. a track folder shown
    // as "elevated_track" but looked up by its node id "Track_elevated_track"), falling
    // back to the visible title for folders that never set a _lookupId.
    const folder = this.children.find(child => child instanceof GUI
        && (child._lookupId === title || child.$title.innerText === title));

    // If found, return it; otherwise, return null
    return folder || null;
}

// Helper to trigger menu bar update when children change
GUI.prototype._notifyMenuBarChanged = function () {
    if (Globals.menuBar && typeof Globals.menuBar.hideEmpty === 'function') {
        // Defer the update to avoid excessive calls during rapid changes
        if (!this._hideEmptyTimeout) {
            this._hideEmptyTimeout = setTimeout(() => {
                Globals.menuBar.hideEmpty();
                this._hideEmptyTimeout = null;
            }, 0);
        }
    }
}

// Store original add method and wrap it
const originalAdd = GUI.prototype.add;
GUI.prototype.add = function (...args) {
    const result = originalAdd.apply(this, args);
    this._notifyMenuBarChanged();
    return result;
};

// Store original addColor method and wrap it
const originalAddColor = GUI.prototype.addColor;
GUI.prototype.addColor = function (...args) {
    const result = originalAddColor.apply(this, args);
    this._notifyMenuBarChanged();
    return result;
};

// Store original addFolder method and wrap it
const originalAddFolder = GUI.prototype.addFolder;
GUI.prototype.addFolder = function (...args) {
    const result = originalAddFolder.apply(this, args);
    this._notifyMenuBarChanged();
    // Make sub-menus (folders) inside a menu-bar menu draggable so they can be
    // torn out into a floating / sidebar-docked window. Only folders whose root
    // is an actual menu-bar menu qualify (this excludes standalone dialogs,
    // context menus, region editors, etc). this.root is cached at construction
    // and stays valid because tear-out never reparents the GUI object.
    if (result) {
        if (result.mode === undefined) result.mode = "DOCKED";
        const mb = Globals.menuBar;
        if (mb && typeof mb._makeFolderDraggable === "function"
            && Array.isArray(mb.slots) && this.root && mb.slots.includes(this.root)) {
            mb._makeFolderDraggable(result);
        }
    }
    return result;
};

// Store original show/hide methods and wrap them
const originalGUIShow = GUI.prototype.show;
GUI.prototype.show = function (...args) {
    const result = originalGUIShow.apply(this, args);
    this._notifyMenuBarChanged();
    return result;
};

const originalGUIHide = GUI.prototype.hide;
GUI.prototype.hide = function (...args) {
    const result = originalGUIHide.apply(this, args);
    this._notifyMenuBarChanged();
    return result;
};

// Store original destroy method and wrap it
const originalDestroy = GUI.prototype.destroy;
GUI.prototype.destroy = function (recursive = true) {
    // Notify before destroying so parent can check its content
    if (this.parent) {
        this.parent._notifyMenuBarChanged();
    }
    return originalDestroy.call(this, recursive);
};

// Extend the lil-gui Controller prototype
Controller.prototype.setLabelColor = function (color) {
    // Find the label element within the controller's DOM
    const label = this.$name;
    if (label) {
        // Add a general class to the controller
        this.domElement.classList.add('custom-controller-label');

        // Create a unique class name for this controller
        const uniqueClass = `controller-label-${Math.random().toString(36).substr(2, 9)}`;

        // Add the unique class to the controller's DOM element
        this.domElement.classList.add(uniqueClass);

        // Add a style element to the head to apply the custom color
        const style = document.createElement('style');
        style.innerHTML = `
                .${uniqueClass} .name {
                    color: ${color} !important;
                }
            `;
        document.head.appendChild(style);
    }

    // Record the color so CustomManagerMirror.mirrorController can replay it
    // on the mirrored copy (the standalone Video Adjustments popup, etc.).
    this._labelColor = color;

    return this; // Return the controller to allow method chaining
};

// adding a tooltip to a controller
Controller.prototype.tooltip = function (tooltip) {
    // Keep the text as readable state as well as a DOM attribute: the two mirroring paths
    // (MenuMirror, CustomManagerMirror) copy a control's tooltip onto its twin, and both read
    // it from here. Without this they saw undefined and quietly produced tooltip-less mirrors.
    this._tooltip = tooltip;

    // Find the label element within the controller's DOM
    const label = this.$name;
    if (label) {
        // Add the tooltip to the controller's DOM element
        this.domElement.title = tooltip;
    }

    return this; // Return the controller to allow method chaining
}

Controller.prototype.setValueQuietly = function (value) {
    // Set the value without triggering the onChange event
    this.object[this.property] = value;

    // Force a real display re-sync. lil-gui's updateDisplay short-circuits when
    // the value is unchanged (value === _lastDisplayedValue) — but after an
    // options rebuild (.options() recreates the <select>) the native select's
    // selectedIndex can default to 0 while the value is unchanged, leaving the
    // dropdown's checkmark stuck on the wrong (first) option even though the
    // bound value and the visible label are correct. Clearing the guard makes
    // updateDisplay actually re-point the select.
    this._lastDisplayedValue = undefined;
    this.updateDisplay();

    return this; // Return the controller to allow method chaining
}

// Add unit conversion support to numerical controllers
// Usage: controller.setUnitType("small") - for height/distance in m/ft
// Controller stores values in current display units (feet or meters)
// External code should use getSIValue()/setSIValue() to interact in SI units
Controller.prototype.setUnitType = function (unitType) {
    // Store the unit type
    this._unitType = unitType;

    // Only works for number controllers with $input
    if (!this.$input) {
        console.warn('setUnitType only works on number controllers');
        return this;
    }

    // Store the original name (without units)
    if (!this._originalName) {
        this._originalName = this._name;
    }

    // Store original min/max/step in SI units (only first time)
    if (this._originalMinSI === undefined) {
        // Assume initial values are in SI units
        this._originalMinSI = this._min;
        this._originalMaxSI = this._max;
        this._originalStepSI = this._step;

        // Convert the initial value from SI to current display units
        if (Units) {
            const unitInfo = Units.factors[Units.units][unitType];
            if (unitInfo) {
                const currentSIValue = this.getValue();
                const displayValue = currentSIValue / unitInfo.toM;
                // Set without triggering onChange
                this.object[this.property] = displayValue;
            }
        }
    }

    // Update the display name with units
    const updateName = () => {
        if (!Units) return;

        const unitInfo = Units.factors[Units.units][this._unitType];
        if (unitInfo) {
            this._name = this._originalName + ' (' + unitInfo.abbrev + ')';
            this.$name.innerHTML = this._name;
        }
    };

    // Convert min/max/step to current display units
    const updateRanges = () => {
        if (!Units) return;

        const unitInfo = Units.factors[Units.units][this._unitType];
        if (!unitInfo) return;

        this._min = this._originalMinSI / unitInfo.toM;
        this._max = this._originalMaxSI / unitInfo.toM;
        this._step = this._originalStepSI / unitInfo.toM;
        this._onUpdateMinMax();
    };

    // Initial setup
    updateName();
    updateRanges();

    // Listen for unit changes
    const onUnitsChange = (oldUnits) => {
        if (!Units) return;

        const oldUnitInfo = Units.factors[oldUnits][this._unitType];
        const newUnitInfo = Units.factors[Units.units][this._unitType];
        if (!oldUnitInfo || !newUnitInfo) return;

        // Convert the stored value from old units to new units
        // old display value * toM = SI value
        // SI value / new toM = new display value
        const conversionFactor = oldUnitInfo.toM / newUnitInfo.toM;
        const oldDisplayValue = this.getValue();
        const newDisplayValue = oldDisplayValue * conversionFactor;

        // Update the stored value without triggering onChange
        this.object[this.property] = newDisplayValue;

        // Update ranges and display
        updateRanges();
        updateName();
        this.updateDisplay();
        
        // Update any mirrored controllers (they share the proxy but need display/range updates)
        if (this._mirrorControllers) {
            for (const mirror of this._mirrorControllers) {
                if (mirror.domElement && mirror._unitType) {
                    // Update mirror's name and ranges for new units
                    if (mirror._originalName) {
                        const mirrorUnitInfo = Units.factors[Units.units][mirror._unitType];
                        if (mirrorUnitInfo) {
                            mirror._name = mirror._originalName + ' (' + mirrorUnitInfo.abbrev + ')';
                            mirror.$name.innerHTML = mirror._name;
                            mirror._min = mirror._originalMinSI / mirrorUnitInfo.toM;
                            mirror._max = mirror._originalMaxSI / mirrorUnitInfo.toM;
                            mirror._step = mirror._originalStepSI / mirrorUnitInfo.toM;
                            mirror._onUpdateMinMax();
                        }
                    }
                    mirror.updateDisplay();
                }
            }
        }
    };

    // Listen for global units changes
    if (!this._unitsCheckInterval) {
        let lastUnits = Units ? Units.units : null;
        this._unitsCheckInterval = setInterval(() => {
            if (Units && Units.units !== lastUnits) {
                const oldUnits = lastUnits;
                lastUnits = Units.units;
                onUnitsChange(oldUnits);
            }
        }, 500);
    }

    this.updateDisplay();

    return this; // Return the controller to allow method chaining
}

// Get value in SI units (meters)
Controller.prototype.getSIValue = function () {
    if (!this._unitType || !Units) {
        return this.getValue();
    }

    const unitInfo = Units.factors[Units.units][this._unitType];
    if (!unitInfo) {
        return this.getValue();
    }

    // Convert from display units to SI units
    const displayValue = this.getValue();
    return displayValue * unitInfo.toM;
}

// Set value in SI units (meters) 
// This updates the controller and any mirrored controllers
// Pass _fromMirror=true to prevent recursive updates
Controller.prototype.setSIValue = function (siValue, _fromMirror = false) {
    if (!this._unitType || !Units) {
        // No unit conversion - just update directly without triggering onChange
        this.object[this.property] = siValue;
        this.updateDisplay();
    } else {
        const unitInfo = Units.factors[Units.units][this._unitType];
        if (!unitInfo) {
            this.object[this.property] = siValue;
            this.updateDisplay();
        } else {
            const displayValue = siValue / unitInfo.toM;
            this.object[this.property] = displayValue;
            this.updateDisplay();
        }
    }
    
    // Update any mirrored controllers (without recursing back)
    if (!_fromMirror && this._mirrorControllers) {
        for (const mirror of this._mirrorControllers) {
            // Skip destroyed controllers (domElement is null after destroy)
            if (mirror.domElement) {
                mirror.setSIValue(siValue, true);
            }
        }
    }
    
    return this;
}

// Get min/max limits in SI units (meters)
// Returns { min, max } object
Controller.prototype.getSILimits = function () {
    if (this._originalMinSI !== undefined && this._originalMaxSI !== undefined) {
        return { min: this._originalMinSI, max: this._originalMaxSI };
    }
    return { min: this._min, max: this._max };
}

// Set this button as the double-click action for its parent GUI/folder
// Allows chaining: gui.add(obj, 'method').name('Button').setDoubleClickAction()
Controller.prototype.setDoubleClickAction = function () {
    // Find the parent GUI
    const parentGui = this.parent;
    if (parentGui && parentGui.setDoubleClickAction) {
        parentGui.setDoubleClickAction(this);
    }

    return this; // Return the controller to allow method chaining
}


// same but for a GUI object (i.e. a folder)
GUI.prototype.setLabelColor = function (color, min = 0) {
    // if color is an obkect, then it's a color object
    // so convert it to a hex string
    if (typeof color === "object") {
        color = color.getStyle();
    }

    // convert back to a color object
    const colorObj = new Color(color);
    if (min > 0) {
        // if the largest component is less than min, then scale it up
        // and scale the other components up by the same amount
        const max = Math.max(colorObj.r, colorObj.g, colorObj.b);
        if (max < min) {
            // handle the case where all components are zero
            if (max === 0) {
                // set to min
                colorObj.set(min, min, min);
            } else {
                colorObj.multiplyScalar(min / max);
            }
        }
    }
    color = colorObj.getStyle();
    this.domElement.style.color = color;
    return this; // Return the controller to allow method chaining
}

// Folder tooltip. Target the title bar ($title) rather than the whole folder
// domElement so the native tooltip appears when hovering the folder's title —
// not over every child row in the (open) folder.
GUI.prototype.tooltip = function (tooltip) {
    (this.$title ?? this.domElement).title = tooltip;
    return this; // Return the GUI to allow method chaining
}

// Set a button action to fire when the folder title is double-clicked
// This is useful for context menus where double-clicking should perform a default action
// If no buttonController is provided, double-clicking will close the menu (same as clicking outside)
GUI.prototype.setDoubleClickAction = function (buttonController) {
    // Store the button controller reference
    this._doubleClickButton = buttonController;

    // Add the double-click listener to the title if not already added
    if (!this._doubleClickListenerAdded) {
        const handleDoubleClickAction = (event) => {
            if (this._doubleClickButton) {
                // Trigger the button's action
                const obj = this._doubleClickButton.object;
                const prop = this._doubleClickButton.property;
                if (obj && prop && typeof obj[prop] === 'function') {
                    obj[prop]();
                }
            } else {
                // No double-click action set - close the menu (same as clicking outside)
                this.destroy();
            }
            event.preventDefault();
            event.stopPropagation();
        };

        // Add dblclick event for mouse users
        this.$title.addEventListener("dblclick", handleDoubleClickAction);

        // Add touch-based double-tap detection for Android (dblclick doesn't work reliably on Android)
        let lastTapTime = 0;
        let lastTapX = 0;
        let lastTapY = 0;
        const doubleTapDelay = 300; // ms - maximum time between taps to count as double-tap
        const doubleTapDistance = 30; // px - maximum distance between taps

        this.$title.addEventListener("touchend", (event) => {
            const currentTime = Date.now();
            const timeDiff = currentTime - lastTapTime;

            // Get touch position
            const touch = event.changedTouches[0];
            const currentX = touch.clientX;
            const currentY = touch.clientY;
            const distance = Math.sqrt(
                Math.pow(currentX - lastTapX, 2) +
                Math.pow(currentY - lastTapY, 2)
            );

            // Check if this is a double-tap
            if (timeDiff < doubleTapDelay && distance < doubleTapDistance) {
                // This is a double-tap - trigger the same action as dblclick
                handleDoubleClickAction(event);
                // Reset to prevent triple-tap from being detected as another double-tap
                lastTapTime = 0;
            } else {
                // Store this tap for potential double-tap detection
                lastTapTime = currentTime;
                lastTapX = currentX;
                lastTapY = currentY;
            }
        });

        this._doubleClickListenerAdded = true;
    }

    return this; // Return the GUI to allow method chaining
}


// Move a controller to the top of its parent
Controller.prototype.moveToFirst = function () {
    const parentElement = this.domElement.parentElement;
    if (parentElement) {
        parentElement.insertBefore(this.domElement, parentElement.firstChild);

        // Find the parent GUI and trigger a refresh of any mirrored GUIs
        let parentGui = this.parent;
        if (parentGui && parentGui._triggerMirrorRefresh) {
            parentGui._triggerMirrorRefresh();
        }
    }
    return this; // Return the controller to allow method chaining
};

// Move a controller to the end of its parent


Controller.prototype.moveToEnd = function () {
    const parentElement = this.domElement.parentElement;
    if (parentElement) {
        parentElement.appendChild(this.domElement);

        // Find the parent GUI and trigger a refresh of any mirrored GUIs
        let parentGui = this.parent;
        if (parentGui && parentGui._triggerMirrorRefresh) {
            parentGui._triggerMirrorRefresh();
        }
    }
    return this; // Return the controller to allow method chaining
};


GUI.prototype.moveToEnd = function () {
    const parentElement = this.domElement.parentElement;
    if (parentElement) {
        parentElement.appendChild(this.domElement);

        // Trigger a refresh of any mirrored GUIs
        this._triggerMirrorRefresh();
    }
    return this; // Return the controller to allow method chaining
}

// Move this folder to sit immediately after a named sibling in the same parent.
// Unlike Controller.moveAfter (which only matches a sibling controller's `.name`),
// this also matches a sibling FOLDER by its `.title` text, so a folder can be
// positioned relative to another folder. Warns (and no-ops) if not found.
GUI.prototype.moveAfter = function (name) {
    const parentElement = this.domElement.parentElement;
    if (!parentElement) return this;
    const target = Array.from(parentElement.children).find(c => {
        if (c === this.domElement) return false;
        const title = c.querySelector(':scope > .title');     // sibling folder
        if (title && title.textContent.trim() === name) return true;
        const cname = c.querySelector(':scope > .name');      // sibling controller
        return !!cname && cname.textContent.trim() === name;
    });
    if (target) {
        parentElement.insertBefore(this.domElement, target.nextSibling);
        this._triggerMirrorRefresh();
    } else {
        console.warn("GUI.moveAfter: Could not find sibling named " + name);
    }
    return this; // Return the folder to allow method chaining
}

// Helper method to trigger refresh of mirrored GUIs
GUI.prototype._triggerMirrorRefresh = function () {
    // Dispatch a custom event that mirroring systems can listen for
    const event = new CustomEvent('gui-order-changed', {
        detail: { gui: this }
    });
    document.dispatchEvent(event);
}

Controller.prototype.moveAfter = function (name) {
    const parentElement = this.domElement.parentElement;
    if (parentElement) {
        // find the child with the name
        const children = Array.from(parentElement.children);
        const child = children.find(c => c.querySelector('.name').innerText === name);
        if (child) {
            parentElement.insertBefore(this.domElement, child.nextSibling);

            // Find the parent GUI and trigger a refresh of any mirrored GUIs
            let parentGui = this.parent;
            if (parentGui && parentGui._triggerMirrorRefresh) {
                parentGui._triggerMirrorRefresh();
            }
        } else {
            console.warn("moveAfter: Could not find child with name " + name);
        }

    }
    return this; // Return the controller to allow method chaining
}




// delete all the children of a GUI
GUI.prototype.destroyChildren = function () {
    Array.from(this.children).forEach(c => c.destroy());

    return this; // Return the controller to allow method chaining

}

// Extend the GUI prototype to add a new method
GUI.prototype.addExternalLink = function (text, url) {
    // Create an object to hold the button action
    const obj = {};

    // Add a method to the object that opens the link
    obj[text] = function () {
        window.open(url, '_blank');
    };

    // Add the button to the GUI
    return this.add(obj, text);
};

// Add a custom HTML element to the GUI
// This creates a controller-like element that can contain arbitrary HTML
GUI.prototype.addHTML = function (html, labelText = '') {
    // Create a wrapper div that looks like a controller
    const wrapper = document.createElement('div');
    wrapper.classList.add('controller', 'custom-html-controller');

    // Create the label part (left side)
    const label = document.createElement('div');
    label.classList.add('name');
    label.textContent = labelText;

    // Create the widget part (right side) that will contain the HTML
    const widget = document.createElement('div');
    widget.classList.add('widget');

    // If html is a string, set it as innerHTML, otherwise append it as a node
    if (typeof html === 'string') {
        widget.innerHTML = html;
    } else {
        widget.appendChild(html);
    }

    // Assemble the controller
    wrapper.appendChild(label);
    wrapper.appendChild(widget);

    // Add to the GUI's children container
    this.$children.appendChild(wrapper);

    // Return an object with methods for manipulation
    return {
        domElement: wrapper,
        widget: widget,
        label: label,
        destroy: () => {
            wrapper.remove();
        },
        hide: () => {
            wrapper.style.display = 'none';
        },
        show: () => {
            wrapper.style.display = '';
        }
    };
};

let injectedLILGUICode = false;

export class CGuiMenuBar {
    constructor() {

        if (!injectedLILGUICode) {

            // For the menu bar, we need to modify the lil-gui code
            // removing the transition logic.
            GUI.prototype.openAnimated = function (open = true) {
                if (this.lockOpenClose) return;

                // Set state immediately
                this._setClosed(!open);

                // Set the aria-expanded attribute for accessibility
                this.$title.setAttribute('aria-expanded', !this._closed);

                // Calculate the target height
                const targetHeight = !open ? '0px' : `${this.$children.scrollHeight}px`;

                // Set initial height
                this.$children.style.height = targetHeight;

                // Ensure the closed class is correctly toggled
                this.domElement.classList.toggle('closed', !open);

                // Remove height after setting it to allow for dynamic resizing
                // but not until next event loop, to allow the height to be set first
                setTimeout(() => {
                    this.$children.style.height = '';
                }, 0);

                return this;
            }
            injectedLILGUICode = true;
        }

        this.divs = [];
        this.divWidth = 1 // 240; // width of a div in pixels
        this.totalWidth = 0; // total width of all the divs
        this.numSlots = 20; // number of empty slots in the menu bar
        this.slots = []; // array of GUI objects

        // Folders (sub-menus) that have been torn out of their parent menu into
        // their own floating / sidebar-docked window. Each is a live lil-gui
        // folder whose domElement has been relocated into its own container div
        // (folder._detachedContainer), while it stays in its parent's
        // children/folders arrays so listen()/serialization/destroy keep working.
        this.detachedFolders = new Set();

        // >0 while we are batch-restoring / batch-detaching folders (deserialize,
        // teardown). Sidebar show/hide dispatches a synchronous window 'resize',
        // so we suppress the off-screen auto-restore check during these batches
        // to avoid re-entrancy on a half-placed folder.
        this._folderBatchDepth = 0;

        this.barHeight = 25; // height of the menu bar

        // Z-index management for bringing clicked menus to front
        this.baseZIndex = 5000; // Base z-index for menu divs
        this.browserMode = false; // When true, prevent undocking/dragging menus

        // Track the currently active persistent menu (dismissOnOutsideClick = false)
        this.activePersistentMenu = null;

        // Track the currently active context menu (dismissOnOutsideClick = true)
        // Only one context menu should be visible at a time
        this.activeContextMenu = null;

        // create a div for the menu bar
        this.menuBar = document.createElement("div");
        this.menuBar.id = "menuBar";
        // position it at the top left
        this.menuBar.style.position = "absolute";
        this.menuBar.style.top = "0px";
        this.menuBar.style.left = "0px";
        this.menuBar.style.height = "100%";
        this.menuBar.style.width = "100%"; // Added this to ensure full width
        // #menuBar is a FULL-WINDOW (100%x100%) positioning container for dropdowns. Give it a high
        // z-index so menus stack above ALL views (so a view can't cover a menu and steal its click),
        // but pointer-events:none so the empty container does NOT become a screen-covering click
        // shield — clicks fall through to the views beneath. Pointer handling is restored
        // (pointerEvents:auto) on the actual menu SURFACES below (bar slots, detached folders,
        // standalone/context menus), so menus get top click priority without blocking views elsewhere.
        this.menuBar.style.zIndex = "9000";
        this.menuBar.style.pointerEvents = "none";
        this.menuBar.style.overflowY = "hidden"; // Prevent scroll - menus handle their own overflow
        this.menuBar.style.overflowX = "hidden"; // Prevent horizontal scrollbar when dragging menus

        this._hidden = false;
        this._restrictedMenuIds = null;

        // add the menuBar to the document body
        document.body.appendChild(this.menuBar);

        // add a black bar div, with a grey 1 pixel border
        const bar = document.createElement("div");
        bar.style.position = "absolute";
        bar.style.top = "0px";
        if (getEnvBool("BANNER_ACTIVE", process.env.BANNER_ACTIVE)) {
            bar.style.top = getEnv("BANNER_HEIGHT", process.env.BANNER_HEIGHT) + "px";
            this.menuBar.style.top = getEnv("BANNER_HEIGHT", process.env.BANNER_HEIGHT) + "px";
        }

        bar.style.left = "0px";
        bar.style.height = this.barHeight + "px"; // one pixel more than the menu title divs
        bar.style.width = "100%";
        bar.style.backgroundColor = "black";
        bar.style.borderBottom = "1px solid grey";
        bar.style.zIndex = 8999; // visual bar, just under the high-z menu surfaces
        bar.style.pointerEvents = "none";
        bar.id = "menuBarBlackBar";

        document.body.appendChild(bar);
        this.bar = bar;

        // Listen for fullscreen changes to update menu bar position
        document.addEventListener('fullscreenchange', () => {
            // Use requestAnimationFrame to wait for browser to finish fullscreen layout
            requestAnimationFrame(() => {
                if (!this._hidden) {
                    this._updateMenuBarPosition();
                } else {
                    // Menu is hidden, but still need to update ViewMan for fullscreen mode
                    ViewMan.updateSize();
                }
            });
        });

        // Listen for window resize to check if floating menus end up off-screen
        window.addEventListener('resize', () => {
            this._checkFloatingMenusOnResize();
        });

        // capture pointerdown events from anywhere on screen to detect if we want to close the GUIs
        document.addEventListener("pointerdown", (event) => {
            // if the click was not in the menu bar, close all the GUIs
            if (!this.menuBar.contains(event.target)) {
                // Close regular menu bar items
                this.slots.forEach((gui) => {
                    gui.close();
                });

                // Close standalone menus (unless locked open)
                const allContainers = Array.from(this.menuBar.children);
                allContainers.forEach((container) => {
                    // Find the GUI associated with this container
                    const gui = container._gui;
                    if (gui && gui._standaloneContainer) {
                        // Only close if not locked open
                        if (!gui.lockOpenClose) {
                            gui.destroy();
                        }
                    }
                });
            }
        });



        // create numSlots empty divs of width divWidth,
        // each positioned at divWidth * i
        //        for (let i = 0; i < this.numSlots; i++) {
        for (let i = this.numSlots - 1; i >= 0; i--) {
            const div = document.createElement("div");
            div.id = "menuBarDiv_" + i;
            div.style.width = this.divWidth + "px";
            div.style.position = "absolute";
            div.style.left = (i * this.divWidth) + "px";
            div.style.top = "0px";

            // since we are only using the divs for positioning,
            // we can set the height to 1px to avoid overlapping divs capturing mouse inputs

            div.style.height = "1px";

            //     div.style.overflowY = "auto"; // Allow scrolling if content overflows
            div.style.zIndex = this.baseZIndex;
            this._markMenuSurface(div);

            this.menuBar.appendChild(div);
            this.divs.push(div);
        }

        this.nextSlot = 0; // next slot to be filled

        // add an info GUI in the top right
        this.infoGUI = new GUI().title("Sitrec").close()
        // keep it above #menuBarBlackBar (8999) / #menuBar (9000), else the black bar paints over it
        this.infoGUI.domElement.style.zIndex = "9001";
        // move it down if there is a banner
        if (getEnvBool("BANNER_ACTIVE", process.env.BANNER_ACTIVE)) {
            this.infoGUI.domElement.style.top = getEnv("BANNER_HEIGHT", process.env.BANNER_HEIGHT) + "px";
        }


        Globals.stats = new Stats();
        // Globals.stats.showPanel( 1 ); // 0: fps, 1: ms, 2: mb, 3+: custom
        // const attach = this.infoGUI.domElement;
        //
        // attach.appendChild( Globals.stats.dom );


    }

    _markMenuSurface(element) {
        if (element) element.style.pointerEvents = "auto";
        return element;
    }

    // Bring a menu to the front by updating its z-index
    bringToFront(gui) {
        if (gui._standaloneContainer || gui._detachedContainer) {
            // This is a standalone menu or a torn-out floating folder
            gui._bringToFront();
        } else {
            // This is a regular menu bar item - use original logic
            const div = this.divs.find((div) => div === gui.domElement.parentElement);

            let maxZIndex = this.baseZIndex;
            // iterate over the slots. If one has a higher zIndex, set it as the maximum
            for (const otherDiv of this.divs) {
                if (div !== otherDiv) {
                    const zIndex = parseInt(otherDiv.style.zIndex);
                    if (zIndex > maxZIndex) {
                        maxZIndex = zIndex;
                    }
                }
            }

            // just use one higher than the max
            maxZIndex++;

            if (div) {
                div.style.zIndex = maxZIndex;
                gui.$children.style.zIndex = maxZIndex;
                gui.$children.style.position = 'relative'; // Ensure positioning context
            }
        }
    }

    resetZIndex(gui) {
        const div = this.divs.find((div) => div === gui.domElement.parentElement);
        div.style.zIndex = this.baseZIndex;
        this._markMenuSurface(div);
        gui.$children.style.zIndex = '';
        gui.$children.style.position = '';
    }



    updateListeners() {

        this.hideEmpty();


        this.slots.forEach((gui) => {
            gui.updateListeners();
        })

        // Standalone (floating) menus are independent GUI roots outside the
        // slots, so their .listen() controllers must be polled here too —
        // otherwise mirrored edit menus never repaint when code changes the
        // bound values (e.g. dragging an overlay/grid's 3D handles).
        this.activePersistentMenu?.updateListeners();
        this.activeContextMenu?.updateListeners();

        // Every OTHER root that wants .listen() to mean something — per-view header menus,
        // mirrored popups — registers itself instead of being special-cased here.
        // See src/GUIRootRegistry.js.
        updateGUIRootListeners();
    }

    show() {
        this.slots.forEach((gui) => {
            gui.show();
        })

        this.infoGUI.show();
        this.bar.style.display = "block";
        this._hidden = false;

        // Update positioning based on full-screen mode
        this._updateMenuBarPosition();
    }

    hide() {
        // call hide on all the GUI slots
        this.slots.forEach((gui) => {
            gui.hide();
        })

        this.infoGUI.hide();
        this.bar.style.display = "none";

        this._hidden = true;

        ViewMan.topPx = 0;
        ViewMan.updateSize();
        //  updateSize();
    }

    // Helper method to update menu bar position based on current state
    _updateMenuBarPosition() {
        // Check if browser is in full-screen mode
        const isFullScreen = document.fullscreenElement !== null;

        // When in browser full-screen mode without banners, add 10px spacing from top
        const topOffset = (isFullScreen && !getEnvBool("BANNER_ACTIVE", process.env.BANNER_ACTIVE)) ? 10 : 0;

        if (getEnvBool("BANNER_ACTIVE", process.env.BANNER_ACTIVE)) {
            // With banner, position below it
            this.bar.style.top = getEnv("BANNER_HEIGHT", process.env.BANNER_HEIGHT) + "px";
            this.menuBar.style.top = getEnv("BANNER_HEIGHT", process.env.BANNER_HEIGHT) + "px";
            ViewMan.topPx = this.barHeight;
        } else {
            // Without banner, use the top offset (10px in full-screen mode, 0px otherwise)
            this.bar.style.top = topOffset + "px";
            this.menuBar.style.top = topOffset + "px";
            ViewMan.topPx = this.barHeight + topOffset;
        }

        ViewMan.updateSize();
    }

    /**
     * Check all floating menus on window resize
     * Close and/or dock any menus that end up >80% off-screen
     */
    _checkFloatingMenusOnResize() {
        // Don't auto-restore while we're mid-batch (deserialize/teardown) - the
        // resize that fired this can be a side effect of sidebar show/hide.
        if (this._folderBatchDepth > 0) return;
        // Check docked menu bar items
        this.slots.forEach((gui) => {
            if (gui && gui.mode === "DETACHED") {
                const div = this.divs.find((d) => d === gui.domElement.parentElement);
                if (div && this.isMenuOffScreen(div)) {
                    // Menu is off-screen, restore it to the menu bar and close
                    if (gui.wasOriginalllyInMenuBar) {
                        this.restoreToBar(gui);
                        gui.close();
                    } else {
                        gui.close();
                    }
                }
            }
        });

        // Check standalone menus
        const allContainers = Array.from(this.menuBar.children);
        allContainers.forEach((container) => {
            const gui = container._gui;
            if (gui && gui._standaloneContainer && this.isMenuOffScreen(container)) {
                // Standalone menu is off-screen, destroy it (same as dragging off-screen)
                gui.destroy();
            }
        });

        // Check floating (DETACHED) torn-out folders. Unlike standalone menus
        // these are never destroyed - they belong to a parent menu, so restore
        // them instead. Sidebar-docked folders ride along with their sidebar.
        for (const folder of Array.from(this.detachedFolders)) {
            if (folder.mode === "DETACHED") {
                const container = folder._detachedContainer;
                if (container && this.isMenuOffScreen(container)) {
                    this.restoreFolderToParent(folder);
                }
            }
        }
    }
    
    _showDropIndicator(side) {
        if (!this._dropIndicator) {
            this._dropIndicator = document.createElement('div');
            this._dropIndicator.style.pointerEvents = 'none';
            document.body.appendChild(this._dropIndicator);
        }
        
        // Reset all positioning and visual styles each time
        this._dropIndicator.style.position = 'fixed';
        this._dropIndicator.style.top = '0';
        this._dropIndicator.style.height = '100%';
        this._dropIndicator.style.zIndex = '10000';
        this._dropIndicator.style.left = '';
        this._dropIndicator.style.right = '';
        this._dropIndicator.style.width = '10px';
        this._dropIndicator.style.backgroundColor = 'rgba(100, 150, 255, 0.5)';
        this._dropIndicator.style.border = 'none';
        this._dropIndicator.style.boxSizing = 'border-box';
        
        const leftSidebar = getLeftSidebar();
        const rightSidebar = getRightSidebar();
        
        if (side === 'left') {
            this._dropIndicator.style.left = '0';
            if (leftSidebar && leftSidebar.style.display !== 'none') {
                this._dropIndicator.style.width = leftSidebar.offsetWidth + 'px';
                this._dropIndicator.style.backgroundColor = 'transparent';
                this._dropIndicator.style.border = '2px solid rgba(100, 150, 255, 0.8)';
            }
        } else if (side === 'right') {
            this._dropIndicator.style.right = '0';
            if (rightSidebar && rightSidebar.style.display !== 'none') {
                this._dropIndicator.style.width = rightSidebar.offsetWidth + 'px';
                this._dropIndicator.style.backgroundColor = 'transparent';
                this._dropIndicator.style.border = '2px solid rgba(100, 150, 255, 0.8)';
            }
        } else if (side === 'center') {
            const csAdj = getCenterSidebarAdjustment();
            const cSidebar = getCenterSidebar();
            if (csAdj.visible && cSidebar) {
                const rect = cSidebar.getBoundingClientRect();
                this._dropIndicator.style.left = rect.left + 'px';
                this._dropIndicator.style.width = rect.width + 'px';
                this._dropIndicator.style.backgroundColor = 'transparent';
                this._dropIndicator.style.border = '2px solid rgba(100, 150, 255, 0.8)';
            } else {
                // Show a narrow indicator at the divider line
                const content = document.getElementById("Content");
                const mainView = ViewMan.get("mainView", false);
                if (content && mainView) {
                    const divFrac = mainView.left + Math.abs(mainView.width);
                    const dividerScreenX = content.offsetLeft + content.offsetWidth * divFrac;
                    this._dropIndicator.style.left = (dividerScreenX - 5) + 'px';
                    this._dropIndicator.style.width = '10px';
                }
            }
        }
        
        this._dropIndicator.style.display = 'block';
    }
    
    _hideDropIndicators() {
        if (this._dropIndicator) {
            this._dropIndicator.style.display = 'none';
        }
    }

    // Check if a screen X coordinate is near the center divider line
    _isNearCenterDivider(clientX) {
        // Center sidebar must be enabled in settings
        if (!Globals.settings?.centerSidebar) return false;

        const csAdj = getCenterSidebarAdjustment();

        // If center sidebar is already visible, check if clientX is within it
        if (csAdj.visible) {
            const sidebar = getCenterSidebar();
            if (sidebar) {
                const rect = sidebar.getBoundingClientRect();
                return clientX >= rect.left && clientX <= rect.right;
            }
        }

        // If not visible, check if we're near the divider line
        const dividerFrac = this._computeDividerFraction();
        if (dividerFrac === null) return false;

        const content = document.getElementById("Content");
        if (!content) return false;

        const dividerScreenX = content.offsetLeft + content.offsetWidth * dividerFrac;
        const tolerance = 30;
        return Math.abs(clientX - dividerScreenX) < tolerance;
    }

    // Compute the divider fraction from the current view layout
    _computeDividerFraction() {
        const mainView = ViewMan.get("mainView", false);
        if (!mainView || !mainView.visible) return null;

        // Only valid when mainView is full height and on the left
        if (mainView.height < 0.99 || mainView.left > 0.01) return null;

        let dividerFrac;
        if (mainView.width > 0) {
            dividerFrac = mainView.left + mainView.width;
        } else {
            // Negative width = aspect ratio encoding; compute from pixels
            dividerFrac = mainView.left + mainView.widthPx / ViewMan.widthPx;
        }

        // Must have space on both sides
        if (dividerFrac >= 0.99 || dividerFrac <= 0.01) return null;
        return dividerFrac;
    }

    toggleVisiblity() {
        if (this._hidden) {
            this.show();
        } else {
            this.hide();
        }
        // Also toggle the controls visibility to maximize view space
        toggleControlsVisibility();
        // Update ViewMan size after controls visibility has changed
        // Use requestAnimationFrame to ensure DOM layout has completed
        requestAnimationFrame(() => {
            ViewMan.updateSize();
        });
    }

    reset() {
        this._restrictedMenuIds = null;
        // Put any torn-out folders back into their parent menus first, so we
        // don't leave orphaned floating windows or sidebar containers behind.
        this._restoreAllDetachedFolders();
        this.slots.forEach((gui) => {
            this.restoreToBar(gui);
            gui.close();
        })
        this.hideEmpty();
    }

    showOnlyMenus(ids) {
        this._restrictedMenuIds = new Set(ids);
        this.hideEmpty();
    }

    showAllMenus() {
        this._restrictedMenuIds = null;
        this.hideEmpty();
    }

    // Hide all non-bar menus (floating, sidebar-docked) for overlay modes like the sitch browser.
    // Menus opened from the menu bar while in this mode will still appear on top.
    hideNonBarMenus() {
        this._hiddenForOverlay = [];
        this.browserMode = true;
        for (const gui of this.slots) {
            if (!gui) continue;
            const mode = gui.mode;
            if (mode === "DETACHED" || mode === "SIDEBAR_LEFT" || mode === "SIDEBAR_RIGHT" || mode === "SIDEBAR_CENTER") {
                const el = gui.domElement;
                if (el && el.style.display !== "none") {
                    this._hiddenForOverlay.push({ el, display: el.style.display });
                    el.style.display = "none";
                }
            }
            // Close any open docked menus
            if (mode === "DOCKED" && !gui._closed) {
                gui.close();
            }
        }
        // Hide any torn-out floating folders too (they aren't in slots).
        for (const folder of this.detachedFolders) {
            const el = folder._detachedContainer;
            if (el && el.style.display !== "none") {
                this._hiddenForOverlay.push({ el, display: el.style.display });
                el.style.display = "none";
            }
        }
        // Also hide sidebars themselves
        for (const fn of [getLeftSidebar, getRightSidebar, getCenterSidebar]) {
            const sb = fn();
            if (sb && sb.style.display !== "none") {
                this._hiddenForOverlay.push({ el: sb, display: sb.style.display });
                sb.style.display = "none";
            }
        }
    }

    // Restore menus hidden by hideNonBarMenus
    restoreNonBarMenus() {
        this.browserMode = false;
        if (!this._hiddenForOverlay) return;
        for (const entry of this._hiddenForOverlay) {
            const el = entry.el ?? entry.gui?.domElement?.parentElement;
            if (el) el.style.display = entry.display || "";
        }
        this._hiddenForOverlay = null;
    }

    // Check if a GUI folder has any visible content (recursively)
    _hasVisibleContent(gui) {
        if (!gui) return false;

        if (gui._hidden) return false;

        for (const child of gui.children) {
            // If it's a folder (GUI), recursively check its content
            if (child instanceof GUI) {
                // A folder that has been torn out into its own floating /
                // sidebar-docked window no longer counts as content of this
                // menu, so a menu whose only content was torn out collapses
                // its menu-bar tab.
                if (this._isFolderDetached(child)) continue;
                if (this._hasVisibleContent(child)) return true;
            } else {
                // It's a controller; only visible controllers count as content
                if (child._hidden) continue;
                return true;
            }
        }
        return false;
    }

    hideEmpty() {
        let x = 0;
        for (let i = 0; i < this.numSlots; i++) {
            const gui = this.slots[i];
            if (gui) {
                const div = this.divs[i];

                // Check if the GUI has any visible content (recursively)
                const hasContent = this._hasVisibleContent(gui);
                const inMenuBar = div.parentElement === this.menuBar;
                // Keep a slot reserved for any visible menu with content, even if detached or sidebar-docked.
                // Only hidden/empty menus collapse their gap in the top menu bar.
                const isRestricted = this._restrictedMenuIds && gui._menuId
                    && !this._restrictedMenuIds.has(gui._menuId);
                const shouldReserveBarSpace = !gui._hidden && hasContent && !isRestricted;

                if (!shouldReserveBarSpace) {
                    // Empty menu - close and hide it
                    gui.close();
                    if (inMenuBar) {
                        div.style.display = "none";
                    }
                } else {
                    // Has content - make sure it's visible
                    if (inMenuBar) {
                        div.style.display = "block";
                    }
                    if (gui.mode === "DOCKED") {
                        div.style.left = x + "px";
                        gui.originalLeft = x;
                    }
                    x += getTextWidth(gui.$title.innerText) + 16;
                }
            }

        }
    }

    // creates a gui, adds it into the next menu slot
    // and returns it.
    // called addFolder to maintain compatibility with a single gui system under dat.gui
    addFolder(title) {
        const newGUI = new GUI({ container: this.divs[this.nextSlot], autoPlace: false });
        //newGUI.title(title);
        newGUI.$title.innerHTML = title;

        //        console.log("Adding GUI "+title+" at slot "+this.nextSlot+" with left "+this.totalWidth+"px")

        assert(this.nextSlot < this.numSlots, "Too many GUIs in the menu bar");

        // Store reference to GUI on the positioning container so we can find it later
        this.divs[this.nextSlot]._gui = newGUI;

        this.divs[this.nextSlot].style.left = this.totalWidth + "px";

        newGUI.originalLeft = this.totalWidth;
        newGUI.originalTop = 0;

        // Mark that this menu was originally created in the menubar
        // This flag persists even if the menu is dragged away and detached
        newGUI.wasOriginalllyInMenuBar = true;

        // const divDebugColor = ["red", "green", "blue", "yellow", "purple", "orange", "pink", "cyan", "magenta", "lime", "teal", "indigo", "violet", "brown", "grey", "black", "white"];
        // // give the div a colored border
        // this.divs[this.nextSlot].style.border = "1px solid "+ divDebugColor[this.nextSlot % divDebugColor.length];

        const width = getTextWidth(newGUI.$title.innerHTML) + 16;
        // this.divs[this.nextSlot].style.width = width + "px";
        // this.divs[this.nextSlot].style.height = "1 px";
        this.totalWidth += width;

        let left = this.totalWidth;
        // adjust the position of all subsequent divs to the right
        for (let i = this.nextSlot + 1; i < this.numSlots; i++) {
            this.divs[i].style.left = left + "px";
            left += this.divWidth;
        }

        // make the div pass through mouse events
        //this.divs[this.nextSlot].style.pointerEvents = "none";


        preventDoubleClicks(newGUI);
        addGUIMouseTracking(newGUI);
        this.slots[this.nextSlot] = newGUI;
        this.nextSlot++;

        newGUI.mode = "DOCKED";

        // when opened, close the others (keep this for user interactions like clicking)
        newGUI.onOpenClose((changedGUI) => {

            if (!changedGUI._closed) {
                // Bring this menu to the front when opened
                this.bringToFront(newGUI);

                this.slots.forEach((gui, index) => {
                    if (gui !== newGUI && !gui._closed) {
                        gui.close();
                    }
                });

                // if this gui only has one child, which is a folder (GUI class), then open it
                // (but not if that folder has been torn out into its own window -
                // opening an off-screen floating folder would be invisible work)
                if (newGUI.children.length === 1 && newGUI.children[0].constructor.name === "GUI"
                    && !this._isFolderDetached(newGUI.children[0])) {
                    newGUI.children[0].open();
                }
            } else {
                //closing, so reset the z-index to base value
                this.resetZIndex(newGUI)
            }
        })

        // allow for opening menus when hovering over the title
        // (if we've already got a menu open)
        // So the initial open is done by clicking, but subsequent opens are done by hovering
        // like with Windows and Mac menus.

        // Bind the method and store the reference in a property (so we can unbind cleanly)
        this.boundHandleTitleMouseOver = this.handleTitleMouseOver.bind(this);
        this.boundHandleTitleMouseDown = this.handleTitleMouseDown.bind(this);
        this.boundHandleTitleDoubleClick = this.handleTitleDoubleClick.bind(this);

        // Add the event listener using the bound method
        newGUI.$title.addEventListener("mouseover", this.boundHandleTitleMouseOver);

        // Use pointerdown instead of mousedown for better off-screen drag support
        newGUI.$title.addEventListener("pointerdown", this.boundHandleTitleMouseDown);
        newGUI.$title.addEventListener("dblclick", this.boundHandleTitleDoubleClick);

        // Add touch-based double-tap detection for Android (dblclick doesn't work reliably on Android)
        let lastTapTime = 0;
        let lastTapX = 0;
        let lastTapY = 0;
        const doubleTapDelay = 300; // ms - maximum time between taps to count as double-tap
        const doubleTapDistance = 30; // px - maximum distance between taps

        newGUI.$title.addEventListener("touchend", (event) => {
            const currentTime = Date.now();
            const timeDiff = currentTime - lastTapTime;

            // Get touch position
            const touch = event.changedTouches[0];
            const currentX = touch.clientX;
            const currentY = touch.clientY;
            const distance = Math.sqrt(
                Math.pow(currentX - lastTapX, 2) +
                Math.pow(currentY - lastTapY, 2)
            );

            // Check if this is a double-tap
            if (timeDiff < doubleTapDelay && distance < doubleTapDistance) {
                // This is a double-tap - trigger the same action as dblclick
                event.preventDefault(); // Prevent any default behavior
                this.handleTitleDoubleClick(event);
                // Reset to prevent triple-tap from being detected as another double-tap
                lastTapTime = 0;
            } else {
                // Store this tap for potential double-tap detection
                lastTapTime = currentTime;
                lastTapX = currentX;
                lastTapY = currentY;
            }
        });

        // Add click listener to the entire GUI to bring it to front when any part is clicked
        newGUI.domElement.addEventListener("pointerdown", (event) => {
            // Only bring to front if this is a detached menu (not docked or currently being ed)
            // console.log(`GUI content pointerdown on menu "${newGUI.$title.innerHTML}", mode: ${newGUI.mode}`);
            if (newGUI.mode === "DETACHED") {
                this.bringToFront(newGUI);
            }
        });

        return newGUI;
    }

    handleTitleDoubleClick(event) {
        // restore the original position
        // event.target will be the title element we just moused over
        // find the GUI object that has this title element
        const newGUI = this.slots.find((gui) => gui.$title === event.target);
        this.restoreToBar(newGUI);
        newGUI.close();
        event.stopPropagation();

    }

    restoreToBar(newGUI) {
        if (this.activePersistentMenu && this.activePersistentMenu._parentGUI === newGUI) {
            this.activePersistentMenu.destroy();
            this.activePersistentMenu = null;
        }

        if (isInLeftSidebar(newGUI)) {
            removeMenuFromLeftSidebar(newGUI);
        }
        if (isInRightSidebar(newGUI)) {
            removeMenuFromRightSidebar(newGUI);
        }

        const newDiv = this.divs.find((div) => div === newGUI.domElement.parentElement);
        
        if (newDiv.parentElement !== this.menuBar) {
            this.menuBar.appendChild(newDiv);
        }
        
        newDiv.style.position = 'absolute';
        newDiv.style.left = newGUI.originalLeft + "px";
        newDiv.style.top = newGUI.originalTop + "px";
        newDiv.style.width = '';
        newDiv.style.height = '1px';
        newDiv.style.zIndex = this.baseZIndex;
        this._markMenuSurface(newDiv);

        newGUI.domElement.style.position = '';
        newGUI.domElement.style.width = '';
        newGUI.$children.style.zIndex = '';
        newGUI.$children.style.position = '';
        newGUI.lockOpenClose = false;
        newGUI.mode = "DOCKED";

        this.applyModeStyles(newGUI);
        this.hideEmpty();
    }

    // ---- Torn-out sub-menus (folders dragged into their own window) ----

    // A folder is "detached" once its DOM has been relocated into its own
    // floating/sidebar container. It stays in its parent's children/folders
    // arrays the whole time (only the DOM moves), so listen(), serialization,
    // path lookups and destroy() cascades keep working.
    _isFolderDetached(folder) {
        return !!(folder && folder._detachedContainer);
    }

    // Wire a folder so its title can be dragged to tear it out of its parent
    // menu, moved around, docked into the sidebars, and double-clicked /
    // dragged off the top to restore it. Idempotent.
    _makeFolderDraggable(folder) {
        if (!folder || folder._tearoutWired) return;
        folder._tearoutWired = true;
        if (folder.mode === undefined) folder.mode = "DOCKED";

        const menuBar = this;

        const onPointerDown = (event) => {
            if (event.isPrimary === false) return;
            if (event.button !== undefined && event.button !== 0) return;
            // In browser/overlay mode dragging is disabled; let the built-in
            // open/close toggle work normally.
            if (menuBar.browserMode) return;

            const isDetached = !!folder._detachedContainer;
            let container = folder._detachedContainer || null;

            // Pre-emptively lock open/close on a docked folder so the built-in
            // lil-gui $title 'mousedown' toggle (fired right after this
            // pointerdown) is a no-op and doesn't flicker the folder while we
            // decide whether this gesture is a click or a tear-out drag.
            const wasLocked = folder.lockOpenClose;
            if (!isDetached && !wasLocked) {
                folder.lockOpenClose = true;
            } else if (isDetached) {
                menuBar.bringToFront(folder);
            }

            const startX = event.clientX;
            const startY = event.clientY;
            let hasDragged = false;

            const wasInLeftSidebar = isInLeftSidebar(folder);
            const wasInRightSidebar = isInRightSidebar(folder);
            const wasInCenterSidebar = isInCenterSidebar(folder);
            let hasUndockedFromSidebar = false;

            const titleRect = folder.$title.getBoundingClientRect();
            const menuBarRect = menuBar.menuBar.getBoundingClientRect();
            const dragOffsetX = event.clientX - titleRect.left;
            const dragOffsetY = event.clientY - titleRect.top;

            const cleanup = () => {
                document.removeEventListener("pointermove", onMove);
                document.removeEventListener("pointerup", onUp);
                document.removeEventListener("pointercancel", onUp);
                menuBar._hideDropIndicators();
            };

            const onMove = (e) => {
                const dx = Math.abs(e.clientX - startX);
                const dy = Math.abs(e.clientY - startY);
                if (dx > 10 || dy > 10) hasDragged = true;

                // First real movement on a docked folder: tear it out at the
                // cursor and continue dragging the new floating container.
                if (!container && hasDragged) {
                    // Tearing a sub-menu out of a menubar-docked menu closes that
                    // menu — its open dropdown would otherwise linger under the
                    // newly floating folder. Sidebar-docked and floating parent
                    // menus stay open (they're persistent windows, not dropdowns).
                    const rootMenu = folder.root;
                    const closeParent = rootMenu && rootMenu.mode === "DOCKED"
                        && menuBar.slots.includes(rootMenu) && !rootMenu._closed;
                    container = menuBar._detachFolder(folder, {
                        x: e.clientX - dragOffsetX - menuBarRect.left,
                        y: e.clientY - dragOffsetY - menuBarRect.top,
                    });
                    if (closeParent) rootMenu.close();
                }

                if (!container) return; // not yet a drag - may still be a click

                // First movement of a sidebar-docked folder: pop it out into a
                // floating window that follows the cursor.
                if ((wasInLeftSidebar || wasInRightSidebar || wasInCenterSidebar) && !hasUndockedFromSidebar && hasDragged) {
                    menuBar.menuBar.appendChild(container);
                    menuBar._markMenuSurface(container);
                    container.style.position = "absolute";
                    container.style.left = (e.clientX - dragOffsetX - menuBarRect.left) + "px";
                    container.style.top = (e.clientY - dragOffsetY - menuBarRect.top) + "px";
                    container.style.width = "240px";
                    container.style.height = "auto";
                    folder.domElement.style.position = "relative";
                    folder.domElement.style.width = "100%";
                    if (wasInLeftSidebar) removeMenuFromLeftSidebar(folder);
                    else if (wasInRightSidebar) removeMenuFromRightSidebar(folder);
                    else removeMenuFromCenterSidebar(folder);
                    hasUndockedFromSidebar = true;
                    folder.mode = "DRAGGING";
                    menuBar.applyModeStyles(folder);
                    folder.lockOpenClose = true;
                    e.preventDefault();
                    return;
                }
                if (!hasUndockedFromSidebar && (wasInLeftSidebar || wasInRightSidebar || wasInCenterSidebar)) {
                    return;
                }

                // Mark as actively dragging so the synchronous 'resize' that
                // sidebar show/hide dispatches doesn't re-enter
                // _checkFloatingMenusOnResize and restore this folder while it
                // is momentarily off-screen mid-drop (that check ignores
                // DRAGGING - it only acts on settled DETACHED folders).
                folder.mode = "DRAGGING";

                container.style.left = (e.clientX - dragOffsetX - menuBarRect.left) + "px";
                container.style.top = (e.clientY - dragOffsetY - menuBarRect.top) + "px";

                // Dragged off the top of the screen -> restore to parent menu.
                if (parseInt(container.style.top) < -5) {
                    menuBar.restoreFolderToParent(folder);
                    cleanup();
                    e.preventDefault();
                    return;
                }

                const viewportWidth = window.innerWidth;
                const menuLeft = parseInt(container.style.left);
                const menuRight = menuLeft + folder.domElement.offsetWidth;
                if (menuLeft < 0) {
                    menuBar._showDropIndicator("left");
                } else if (menuRight > viewportWidth) {
                    menuBar._showDropIndicator("right");
                } else if (menuBar._isNearCenterDivider(e.clientX)) {
                    menuBar._showDropIndicator("center");
                } else {
                    menuBar._hideDropIndicators();
                }
                e.preventDefault();
            };

            const onUp = (e) => {
                cleanup();

                if (!container) {
                    // Pure click (no drag): reproduce the folder open/close
                    // toggle we suppressed on pointerdown.
                    if (!isDetached && !wasLocked) {
                        folder.lockOpenClose = false;
                        folder.openAnimated(folder._closed);
                    }
                    return;
                }

                // Released without ever leaving the sidebar - stay docked.
                if ((wasInLeftSidebar || wasInRightSidebar || wasInCenterSidebar) && !hasUndockedFromSidebar) {
                    e.preventDefault();
                    return;
                }

                const viewportWidth = window.innerWidth;
                const menuLeft = parseInt(container.style.left);
                const menuRight = menuLeft + folder.domElement.offsetWidth;

                if (hasDragged && menuLeft < 0) {
                    addMenuToLeftSidebar(folder);
                    folder.mode = "SIDEBAR_LEFT";
                    folder.lockOpenClose = false; folder.open(); folder.lockOpenClose = true;
                    menuBar.applyModeStyles(folder);
                    menuBar.hideEmpty();
                    e.preventDefault();
                    return;
                }
                if (hasDragged && menuRight > viewportWidth) {
                    addMenuToRightSidebar(folder);
                    folder.mode = "SIDEBAR_RIGHT";
                    folder.lockOpenClose = false; folder.open(); folder.lockOpenClose = true;
                    menuBar.applyModeStyles(folder);
                    menuBar.hideEmpty();
                    e.preventDefault();
                    return;
                }
                if (hasDragged && menuBar._isNearCenterDivider(e.clientX)) {
                    const dividerFraction = menuBar._computeDividerFraction();
                    if (dividerFraction !== null) {
                        addMenuToCenterSidebar(folder, dividerFraction);
                        folder.mode = "SIDEBAR_CENTER";
                        folder.lockOpenClose = false; folder.open(); folder.lockOpenClose = true;
                        menuBar.applyModeStyles(folder);
                        menuBar.hideEmpty();
                        e.preventDefault();
                        return;
                    }
                }

                // Dropped (mostly) off-screen -> restore to parent instead of
                // leaving an unreachable floating folder.
                if (menuBar.isMenuOffScreen(container)) {
                    menuBar.restoreFolderToParent(folder);
                    e.preventDefault();
                    return;
                }

                // Otherwise it remains a floating DETACHED folder.
                folder.mode = "DETACHED";
                menuBar.bringToFront(folder);
                menuBar.applyModeStyles(folder);
                menuBar.hideEmpty();
                e.preventDefault();
            };

            document.addEventListener("pointermove", onMove);
            document.addEventListener("pointerup", onUp);
            document.addEventListener("pointercancel", onUp);
        };

        folder.$title.addEventListener("pointerdown", onPointerDown);

        // Double-click the title of a floating folder to close it (= restore it
        // into the menu it came from).
        folder.$title.addEventListener("dblclick", (event) => {
            if (folder._detachedContainer) {
                menuBar.restoreFolderToParent(folder);
                event.stopPropagation();
                event.preventDefault();
            }
        });

        // Android double-tap (dblclick is unreliable there), mirroring the
        // top-level menu double-tap handling.
        let lastTapTime = 0, lastTapX = 0, lastTapY = 0;
        folder.$title.addEventListener("touchend", (event) => {
            if (!folder._detachedContainer) return;
            const now = Date.now();
            const touch = event.changedTouches[0];
            const dist = Math.sqrt(Math.pow(touch.clientX - lastTapX, 2) + Math.pow(touch.clientY - lastTapY, 2));
            if (now - lastTapTime < 300 && dist < 30) {
                event.preventDefault();
                menuBar.restoreFolderToParent(folder);
                lastTapTime = 0;
            } else {
                lastTapTime = now; lastTapX = touch.clientX; lastTapY = touch.clientY;
            }
        });
    }

    // Tear a folder out of its parent menu into its own floating container.
    // Returns the container div. pos = {x, y} is the desired top-left in
    // menuBar-relative coordinates.
    _detachFolder(folder, pos) {
        const parent = folder.parent;

        // Comment-node placeholder marks the exact DOM slot to restore into. A
        // comment (not an element) does not defeat the lil-gui ".children:empty"
        // styling of the parent if the folder was its only child.
        const placeholder = document.createComment("torn-out-submenu");
        if (folder.domElement.parentNode) {
            folder.domElement.parentNode.insertBefore(placeholder, folder.domElement);
        } else if (parent && parent.$children) {
            parent.$children.appendChild(placeholder);
        }
        folder._detachPlaceholder = placeholder;
        folder._detachParentGUI = parent;

        // Floating positioning container (analogous to a menu-bar slot div or a
        // standalone menu's containerDiv).
        const container = document.createElement("div");
        container.style.position = "absolute";
        container.style.left = ((pos && pos.x != null) ? pos.x : 100) + "px";
        container.style.top = ((pos && pos.y != null) ? pos.y : 100) + "px";
        container.style.width = "240px";
        container.style.height = "auto";
        container.style.zIndex = (this.baseZIndex + 1000);
        this._markMenuSurface(container);
        this.menuBar.appendChild(container);
        container._gui = folder;
        folder._detachedContainer = container;

        // Relocate the folder DOM and make it look/lay out like a top menu.
        container.appendChild(folder.domElement);
        folder.domElement.classList.add("root");
        folder.domElement.classList.add("allow-touch-styles");
        folder.domElement.style.position = "relative";
        folder.domElement.style.width = "100%";

        // Open and lock open while floating.
        folder.lockOpenClose = false;
        folder.open();
        folder.lockOpenClose = true;

        folder.mode = "DETACHED";
        this.applyModeStyles(folder);

        folder._bringToFront = () => {
            let maxZIndex = this.baseZIndex + 1000;
            for (const c of Array.from(this.menuBar.children)) {
                if (c !== container) {
                    const z = parseInt(c.style.zIndex);
                    if (z > maxZIndex) maxZIndex = z;
                }
            }
            container.style.zIndex = maxZIndex + 1;
        };

        this.detachedFolders.add(folder);
        folder._bringToFront();
        this.hideEmpty();
        return container;
    }

    // Restore a torn-out folder back into the menu it came from.
    restoreFolderToParent(folder) {
        if (!folder || !folder._detachedContainer) return;
        const container = folder._detachedContainer;
        const parent = folder._detachParentGUI;
        const placeholder = folder._detachPlaceholder;

        // Sidebar bookkeeping (array only; DOM is handled below).
        if (isInLeftSidebar(folder)) removeMenuFromLeftSidebar(folder);
        if (isInRightSidebar(folder)) removeMenuFromRightSidebar(folder);
        if (isInCenterSidebar(folder)) removeMenuFromCenterSidebar(folder);

        // Undo the floating styling.
        folder.domElement.classList.remove("root");
        folder.domElement.classList.remove("allow-touch-styles");
        folder.domElement.style.position = "";
        folder.domElement.style.width = "";
        folder.$children.style.zIndex = "";
        folder.$children.style.position = "";

        // Put the folder DOM back where it was.
        if (placeholder && placeholder.parentNode) {
            placeholder.parentNode.replaceChild(folder.domElement, placeholder);
        } else if (parent && parent.$children) {
            parent.$children.appendChild(folder.domElement);
        }
        if (placeholder && placeholder.parentNode) {
            placeholder.parentNode.removeChild(placeholder);
        }

        // Remove the now-empty floating container.
        if (container.parentNode) container.parentNode.removeChild(container);

        folder.mode = "DOCKED";
        this.applyModeStyles(folder);

        // Collapse it back as part of "closing" it (matches restoreToBar).
        folder.lockOpenClose = false;
        folder.close();

        delete folder._detachedContainer;
        delete folder._detachParentGUI;
        delete folder._detachPlaceholder;
        delete folder._bringToFront;
        this.detachedFolders.delete(folder);

        this.hideEmpty();
    }

    // Restore every torn-out folder (used before destroy/reset/deserialize so
    // we never leave orphaned floating containers or placeholders behind).
    _restoreAllDetachedFolders() {
        if (!this.detachedFolders || this.detachedFolders.size === 0) return;
        this._folderBatchDepth++;
        try {
            for (const folder of Array.from(this.detachedFolders)) {
                try {
                    this.restoreFolderToParent(folder);
                } catch (e) {
                    console.warn("Failed to restore detached folder", e);
                }
            }
            this.detachedFolders.clear();
        } finally {
            this._folderBatchDepth--;
        }
    }

    // Re-detach a folder during deserialization into the saved mode/position.
    _detachFolderForRestore(folder, detached, collections) {
        const left = parseInt(detached.left);
        const top = parseInt(detached.top);
        const container = this._detachFolder(folder, {
            x: Number.isFinite(left) ? left : 100,
            y: Number.isFinite(top) ? top : 100,
        });
        if (detached.zIndex) container.style.zIndex = detached.zIndex;

        if (detached.mode === "SIDEBAR_LEFT" && collections) {
            folder.mode = "SIDEBAR_LEFT";
            collections.left.push({ gui: folder, index: detached.sidebarIndex ?? 0 });
        } else if (detached.mode === "SIDEBAR_RIGHT" && collections) {
            folder.mode = "SIDEBAR_RIGHT";
            collections.right.push({ gui: folder, index: detached.sidebarIndex ?? 0 });
        } else if (detached.mode === "SIDEBAR_CENTER" && collections) {
            folder.mode = "SIDEBAR_CENTER";
            collections.center.push({ gui: folder, index: detached.sidebarIndex ?? 0 });
        } else {
            folder.mode = "DETACHED";
            this.ensureMenuOnScreen(container);
        }
        this.applyModeStyles(folder);
    }

    /**
     * Check if a menu tab is >80% off-screen
     * Returns true if most of the tab (title bar - the clickable area) is outside the viewport
     * 
     * NOTE: We check the tab title bar area (what you can click on), not the entire menu content.
     * This ensures you can still interact with the tab even if menu contents are off-screen.
     */
    isMenuOffScreen(newDiv) {
        // If newDiv is a positioning container (1x1), find the tab element (title bar)
        let tabElement = newDiv;

        // Try to find the GUI element's title bar (the clickable tab)
        if (newDiv._gui) {
            tabElement = newDiv._gui.$title;
        } else {
            // Search for a title element inside this div
            const titleElement = newDiv.querySelector('.title');
            if (titleElement) {
                tabElement = titleElement;
            }
        }

        const rect = tabElement.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Calculate how much of the tab is visible
        const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
        const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));

        // Calculate the visible area as a percentage of the tab
        const tabArea = rect.width * rect.height;
        const visibleArea = visibleWidth * visibleHeight;
        const visiblePercentage = tabArea > 0 ? (visibleArea / tabArea) * 100 : 0;

        // Return true if less than 20% of the tab is visible (i.e., >80% off-screen)
        return visiblePercentage < 20;
    }

    /**
     * Ensure a standalone menu container is fully on screen
     * If any part is off screen, move it back so it's entirely visible
     * @param {HTMLElement} containerDiv - The container div for the standalone menu
     */
    ensureMenuOnScreen(containerDiv) {
        // Get the container's current position and size
        const rect = containerDiv.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Parse current position
        let left = parseInt(containerDiv.style.left);
        let top = parseInt(containerDiv.style.top);

        // Check and adjust horizontal position
        if (rect.left < 0) {
            // Menu is off screen to the left
            left = 0;
        } else if (rect.right > viewportWidth) {
            // Menu is off screen to the right
            left = viewportWidth - rect.width;
        }

        // Check and adjust vertical position
        if (rect.top < 0) {
            // Menu is off screen at the top
            top = 0;
        } else if (rect.bottom > viewportHeight) {
            // Menu is off screen at the bottom
            top = viewportHeight - rect.height;
        }

        // Apply adjusted position
        containerDiv.style.left = left + "px";
        containerDiv.style.top = top + "px";
    }

    /**
     * Move a standalone menu sideways so it does not cover the point it was opened at.
     *
     * A right-click on a 3D object opens that object's menu under the cursor — which is
     * exactly where the object is, so the menu hides the thing you just asked to edit.
     * Shift it right by half its width; if that would run its right edge past the
     * viewport, put it to the LEFT of the click instead, by one and a half widths.
     *
     * Call once the menu is populated, so the width read here is the real one.
     *
     * @param {GUI} gui - a menu from createStandaloneMenu()
     * @param {number} x - the clientX the menu was created at
     */
    placeMenuBesidePoint(gui, x) {
        const containerDiv = gui?._standaloneContainer;
        if (!containerDiv) return;

        const width = containerDiv.getBoundingClientRect().width || parseInt(containerDiv.style.width);
        if (!(width > 0)) return;

        const viewportWidth = window.innerWidth;

        let left = x + width / 2;
        if (left + width > viewportWidth) {
            left = x - width * 1.5;
        }

        if (left < 0) {
            // Neither offset fits — the viewport is narrower than the rule assumes.
            // Simply clamping to 0 here would put the menu back OVER the click (a 240px
            // menu at a click of x=200 in a 500px window spans 0-240), which is the
            // obstruction this whole method exists to avoid. So fall back to whichever
            // side can still hold the menu CLEAR of the click, pushed as far from it as
            // that side allows, and prefer the side with the bigger gap.
            const flushRight = viewportWidth - width;   // clears the click when >= x
            const rightGap = flushRight - x;
            const leftGap = x - width;                  // flush left clears when >= 0
            if (rightGap >= 0 || leftGap >= 0) {
                left = rightGap >= leftGap ? flushRight : 0;
            } else {
                // Too wide for either side to clear it; just keep the menu on screen.
                left = Math.min(Math.max(0, x), Math.max(0, flushRight));
            }
        }

        containerDiv.style.left = left + "px";
        // Kept in step, or undocking would snap the menu back over the object:
        // originalLeft is what restores the position (see reattach paths).
        gui.originalLeft = left;
    }

    /**
     * Pin a standalone menu one menu line below the top menu bar.
     *
     * An object's edit menu opens at the cursor, which is ON the object. Shifting it
     * sideways (placeMenuBesidePoint) stops it covering that object, but it still lands
     * at whatever height the click happened to be — over the middle of the scene as
     * often as not. Dropping it to a fixed row just under the bar puts every object menu
     * in the same, predictable, out-of-the-way place.
     *
     * Measured in the container's OWN coordinate space, which shares an origin with the
     * bar (both are pushed down by the banner when there is one), so no banner offset
     * enters into it.
     */
    pinMenuBelowBar(gui) {
        const containerDiv = gui?._standaloneContainer;
        if (!containerDiv) return;

        // A "menu line" is one title bar. barHeight is deliberately a pixel more than
        // those, so it is the right fallback when the title has not been laid out yet.
        const lineHeight = gui.$title?.getBoundingClientRect().height || this.barHeight;
        const top = this.barHeight + lineHeight;

        containerDiv.style.top = top + "px";
        // Kept in step for the same reason as originalLeft: the reattach paths restore
        // the position from it.
        gui.originalTop = top;
    }

    applyModeStyles(gui) {
        const titleElement = gui.$title;

        if (gui.mode === "DOCKED" || gui.mode === "SIDEBAR_LEFT" || gui.mode === "SIDEBAR_RIGHT" || gui.mode === "SIDEBAR_CENTER") {
            titleElement.style.removeProperty('border-top-left-radius');
            titleElement.style.removeProperty('border-top-right-radius');
            titleElement.style.removeProperty('border-top');
            titleElement.style.removeProperty('border-left');
            titleElement.style.removeProperty('border-right');
            titleElement.style.removeProperty('box-shadow');
        } else {
            titleElement.style.setProperty('border-top-left-radius', '6px', 'important');
            titleElement.style.setProperty('border-top-right-radius', '6px', 'important');
            titleElement.style.setProperty('border-top', '1px solid #555', 'important');
            titleElement.style.setProperty('border-left', '1px solid #555', 'important');
            titleElement.style.setProperty('border-right', '1px solid #555', 'important');
            titleElement.style.setProperty('box-shadow', '0 2px 8px rgba(0, 0, 0, 0.3)', 'important');
        }
    }

    handleTitleMouseDown(event) {
        const newGUI = this.slots.find((gui) => gui.$title === event.target);

        // Reset any scroll on the menuBar container (defensive - shouldn't scroll with overflow:hidden)
        this.menuBar.scrollTop = 0;

        this.bringToFront(newGUI);

        // In browser mode, allow click-to-open but prevent dragging/undocking
        if (this.browserMode) return;

        const newDiv = this.divs.find((div) => div === newGUI.domElement.parentElement);

        const startX = event.clientX;
        const startY = event.clientY;
        let hasDragged = false;

        const wasInLeftSidebar = isInLeftSidebar(newGUI);
        const wasInRightSidebar = isInRightSidebar(newGUI);
        const wasInCenterSidebar = isInCenterSidebar(newGUI);
        let hasUndockedFromSidebar = false;

        const divRect = newDiv.getBoundingClientRect();
        const menuBarRect = this.menuBar.getBoundingClientRect();
        const dragOffsetX = event.clientX - divRect.left;
        const dragOffsetY = event.clientY - divRect.top;

        if (!(wasInLeftSidebar || wasInRightSidebar || wasInCenterSidebar)) {
            newGUI.mode = "DRAGGING"
            this.applyModeStyles(newGUI)

            if (newGUI._closed) {
                newGUI.lockOpenClose = false;
                newGUI.open();
            }
            newGUI.lockOpenClose = true;
        }

        const boundHandlePointerMove = (event) => {
            const dx = Math.abs(event.clientX - startX);
            const dy = Math.abs(event.clientY - startY);
            const wasDragging = hasDragged;
            if (dx > 10 || dy > 10) {
                hasDragged = true;
            }

            if ((wasInLeftSidebar || wasInRightSidebar || wasInCenterSidebar) && !hasUndockedFromSidebar && hasDragged) {
                this.menuBar.appendChild(newDiv);
                this._markMenuSurface(newDiv);
                newDiv.style.position = 'absolute';
                newDiv.style.left = (event.clientX - dragOffsetX - menuBarRect.left) + 'px';
                newDiv.style.top = (event.clientY - dragOffsetY - menuBarRect.top) + 'px';
                newDiv.style.width = '';
                newDiv.style.height = '1px';

                newGUI.domElement.style.position = '';
                newGUI.domElement.style.width = '';

                if (wasInLeftSidebar) {
                    removeMenuFromLeftSidebar(newGUI);
                } else if (wasInRightSidebar) {
                    removeMenuFromRightSidebar(newGUI);
                } else {
                    removeMenuFromCenterSidebar(newGUI);
                }
                hasUndockedFromSidebar = true;
                
                newGUI.mode = "DRAGGING"
                this.applyModeStyles(newGUI)
                newGUI.lockOpenClose = true;
                
                event.preventDefault();
                return;
            }
            
            if (!hasUndockedFromSidebar && (wasInLeftSidebar || wasInRightSidebar || wasInCenterSidebar)) {
                return;
            }

            // Don't update position until drag was confirmed by a PREVIOUS event.
            // This prevents phantom pointermove events (fired by browsers during
            // fullscreen transitions with bogus coordinates) from repositioning the menu.
            if (!wasDragging) {
                event.preventDefault();
                return;
            }

            newDiv.style.left = (event.clientX - dragOffsetX - menuBarRect.left) + 'px';
            newDiv.style.top = (event.clientY - dragOffsetY - menuBarRect.top) + 'px';

            if (parseInt(newDiv.style.top) < -5) {
                this.restoreToBar(newGUI);
                document.removeEventListener("pointermove", boundHandlePointerMove);
                document.removeEventListener("pointerup", boundHandlePointerUp);
                newGUI.close();
                this._hideDropIndicators();
                event.preventDefault();
                return;
            }
            
            const viewportWidth = window.innerWidth;
            const menuLeft = parseInt(newDiv.style.left);
            const menuRight = menuLeft + newGUI.domElement.offsetWidth;

            if (menuLeft < 0) {
                this._showDropIndicator('left');
            } else if (menuRight > viewportWidth) {
                this._showDropIndicator('right');
            } else if (this._isNearCenterDivider(event.clientX)) {
                this._showDropIndicator('center');
            } else {
                this._hideDropIndicators();
            }

            event.preventDefault();
        }

        document.addEventListener("pointermove", boundHandlePointerMove);

        const boundHandlePointerUp = (event) => {
            document.removeEventListener("pointermove", boundHandlePointerMove);
            document.removeEventListener("pointerup", boundHandlePointerUp);
            this._hideDropIndicators();

            if ((wasInLeftSidebar || wasInRightSidebar || wasInCenterSidebar) && !hasUndockedFromSidebar) {
                event.preventDefault();
                return;
            }

            const viewportWidth = window.innerWidth;
            const menuLeft = parseInt(newDiv.style.left);
            const menuRight = menuLeft + newGUI.domElement.offsetWidth;

            if (hasDragged && menuLeft < 0) {
                addMenuToLeftSidebar(newGUI);
                newGUI.mode = "SIDEBAR_LEFT";
                newGUI.lockOpenClose = false;
                newGUI.open();
                newGUI.lockOpenClose = true;
                this.applyModeStyles(newGUI);
                this.hideEmpty();
                event.preventDefault();
                return;
            }

            if (hasDragged && menuRight > viewportWidth) {
                addMenuToRightSidebar(newGUI);
                newGUI.mode = "SIDEBAR_RIGHT";
                newGUI.lockOpenClose = false;
                newGUI.open();
                newGUI.lockOpenClose = true;
                this.applyModeStyles(newGUI);
                this.hideEmpty();
                event.preventDefault();
                return;
            }

            if (hasDragged && this._isNearCenterDivider(event.clientX)) {
                const dividerFraction = this._computeDividerFraction();
                if (dividerFraction !== null) {
                    addMenuToCenterSidebar(newGUI, dividerFraction);
                    newGUI.mode = "SIDEBAR_CENTER";
                    newGUI.lockOpenClose = false;
                    newGUI.open();
                    newGUI.lockOpenClose = true;
                    this.applyModeStyles(newGUI);
                    this.hideEmpty();
                    event.preventDefault();
                    return;
                }
            }

            if (this.isMenuOffScreen(newDiv)) {
                if (newGUI.wasOriginalllyInMenuBar) {
                    this.restoreToBar(newGUI);
                    newGUI.close();
                    event.stopPropagation();
                } else {
                    newGUI.close();
                }
                event.preventDefault();
                return;
            }
            
            if (newGUI.wasOriginalllyInMenuBar && parseInt(newDiv.style.top) < 5) {
                newDiv.style.left = newGUI.originalLeft + "px";
                newDiv.style.top = newGUI.originalTop + "px";
                newGUI.lockOpenClose = false;
                newGUI.mode = "DOCKED";
            } else {
                newGUI.mode = "DETACHED";
                this.bringToFront(newGUI);
            }
            this.applyModeStyles(newGUI)
            this.hideEmpty();

            event.preventDefault();
        }
        
        document.addEventListener("pointerup", boundHandlePointerUp);

        event.preventDefault();
    }



    handleTitleMouseOver(event) {
        // When mousing over a menu bar title, if there's another docked menu open, close it and switch to this one
        // event.target will be the title element we just moused over
        const newGUI = this.slots.find((gui) => gui.$title === event.target);

        if (!newGUI) {
            return;
        }

        // Only enable hover-to-switch for docked menu bar menus (ignore undocked/floating menus)
        if (newGUI.mode !== "DOCKED" || !newGUI.wasOriginalllyInMenuBar) {
            return;
        }

        // Find if there are any other docked menus currently open
        const otherOpenDockedMenus = this.slots.filter((gui) =>
            !gui._closed &&
            gui !== newGUI &&
            gui.mode === "DOCKED" &&
            gui.wasOriginalllyInMenuBar
        );

        // If there are other docked menus open, close them and open this one
        if (otherOpenDockedMenus.length > 0) {
            otherOpenDockedMenus.forEach((gui) => {
                gui.close();
            });
            newGUI.open();
        }
    }

    destroy(all = true) {
        // Put torn-out folders back into their parents first, so the recursive
        // GUI.destroy() below cleans them up normally instead of leaving
        // orphaned floating containers / placeholder nodes behind.
        this._restoreAllDetachedFolders();
        for (let i = this.numSlots - 1; i >= 0; i--) {
            const gui = this.slots[i];
            if (gui) {

                gui.$title.removeEventListener("mouseover", this.boundHandleTitleMouseOver);
                gui.$title.removeEventListener("pointerdown", this.boundHandleTitleMouseDown);
                gui.$title.removeEventListener("dblclick", this.boundHandleTitleDoubleClick);

                gui.destroy(all);

                if (all || !gui.permanent) {
                    // splice out the slots and divs
                    this.slots.splice(i, 1);

                    // temp reference to the div
                    const div = this.divs[i];
                    // remove div
                    this.divs.splice(i, 1);
                    // move the div at i to the end. so it can be reused
                    // not really ideal, but it's a quick fix
                    // we probably want more control over the order per-sitch
                    this.divs.push(div)

                    this.nextSlot--;
                }
            }
        }

    }

    getSerialID(slot) {
        const gui = this.slots[slot];
        return gui?._menuId ?? gui.$title.innerHTML
    }

    getSerialAliases(gui) {
        const aliases = [
            gui?._menuId,
            gui?.$title?.innerHTML,
            ...(Array.isArray(gui?._serializationAliases) ? gui._serializationAliases : []),
        ].filter(value => typeof value === "string" && value.length > 0);

        return [...new Set(aliases)];
    }

    getSerializedGUIData(guiData, gui) {
        for (const key of this.getSerialAliases(gui)) {
            if (guiData[key] !== undefined) {
                return guiData[key];
            }
        }

        return undefined;
    }

    // Walk a folder's subfolders and capture each one's open/closed state,
    // keyed by title. Used by modSerialize so a saved sitch remembers which
    // submenus the user had expanded. Sibling folders with duplicate titles
    // are not distinguished — the last one wins (rare in practice).
    _serializeFolderStates(gui) {
        const out = {};
        if (!gui || !gui.folders) return out;
        for (const f of gui.folders) {
            const key = f.$title?.innerHTML;
            if (!key) continue;
            const entry = {
                closed: f._closed,
                folders: this._serializeFolderStates(f),
            };
            // If this folder has been torn out into its own floating /
            // sidebar-docked window, remember enough to recreate it on reload.
            if (this._isFolderDetached(f)) {
                const c = f._detachedContainer;
                const detached = { mode: f.mode };
                if (c) {
                    detached.left = c.style.left;
                    detached.top = c.style.top;
                    detached.zIndex = c.style.zIndex;
                }
                if (f.mode === "SIDEBAR_LEFT") {
                    detached.sidebarIndex = getLeftSidebarMenuIndex(f);
                } else if (f.mode === "SIDEBAR_RIGHT") {
                    detached.sidebarIndex = getRightSidebarMenuIndex(f);
                } else if (f.mode === "SIDEBAR_CENTER") {
                    detached.sidebarIndex = getCenterSidebarMenuIndex(f);
                }
                entry.detached = detached;
            }
            out[key] = entry;
        }
        return out;
    }

    // Apply a previously-captured folder-state map. Folders that no longer
    // exist (renamed, removed, or not yet created) are silently skipped;
    // folders without a matching entry keep their current default state.
    _applyFolderStates(gui, data, collections) {
        if (!gui || !gui.folders || !data) return;
        for (const f of gui.folders) {
            const key = f.$title?.innerHTML;
            if (!key) continue;
            const entry = data[key];
            if (!entry) continue;
            if (entry.detached) {
                // Re-tear-out this folder. Sidebar placements are collected and
                // applied (sorted by index) together with the top-level menus.
                this._detachFolderForRestore(f, entry.detached, collections);
            } else {
                if (entry.closed === true) f.close();
                else if (entry.closed === false) f.open();
            }
            // Recurse parent-first so a folder torn out of an already-torn-out
            // folder is detached after its (already-detached) ancestor.
            this._applyFolderStates(f, entry.folders, collections);
        }
    }

    modSerialize() {

        // serialize the GUIs by index
        // as we have issue with nested structures
        // each entry has a uniquie key
        const out = {};
        for (let i = 0; i < this.slots.length; i++) {
            const gui = this.slots[i];
            const serialized = {
                closed: gui._closed,
                left: gui.domElement.parentElement.style.left,
                top: gui.domElement.parentElement.style.top,
                zIndex: gui.$children.style.zIndex || gui.domElement.parentElement.style.zIndex,
                mode: gui.mode,
                lockOpenClose: gui.lockOpenClose,
                folders: this._serializeFolderStates(gui),
            };
            if (gui.mode === "SIDEBAR_LEFT") {
                serialized.sidebarIndex = getLeftSidebarMenuIndex(gui);
            } else if (gui.mode === "SIDEBAR_RIGHT") {
                serialized.sidebarIndex = getRightSidebarMenuIndex(gui);
            } else if (gui.mode === "SIDEBAR_CENTER") {
                serialized.sidebarIndex = getCenterSidebarMenuIndex(gui);
            }
            out[this.getSerialID(i)] = serialized;
        }

        return out;
    }


    modDeserialize(v) {
        const guiData = v;
        // Start from a clean slate: put any currently torn-out folders back so
        // a re-deserialize (or a reused menu bar) doesn't leave stale windows.
        this._restoreAllDetachedFolders();
        // Suppress off-screen auto-restore for the duration (sidebar add/remove
        // below dispatches synchronous 'resize' events).
        this._folderBatchDepth++;
        try {
        const leftSidebarMenusToAdd = [];
        const rightSidebarMenusToAdd = [];
        const centerSidebarMenusToAdd = [];
        // Detached folders share the same sidebars (and ordering) as top-level
        // menus, so they push into the same collections.
        const sidebarCollections = {
            left: leftSidebarMenusToAdd,
            right: rightSidebarMenusToAdd,
            center: centerSidebarMenusToAdd,
        };

        for (let i = 0; i < this.slots.length; i++) {
            const gui = this.slots[i];
            const data = this.getSerializedGUIData(guiData, gui);
            if (data !== undefined) {
                // When loading a sitch, all docked menus should be closed
                // Ignore the serialized closed state and always close menus
                // This ensures the internal _closed state matches the DOM (closed class and aria-expanded attribute)
                gui.close();
                gui.domElement.parentElement.style.left = data.left;
                gui.domElement.parentElement.style.top = data.top;
                this._markMenuSurface(gui.domElement.parentElement);
                // Restore z-index if available, otherwise use base value
                if (data.zIndex !== undefined) {
                    const zIndexValue = parseInt(data.zIndex) || this.baseZIndex;
                    if (zIndexValue > this.baseZIndex) {
                        // High z-index goes to children
                        gui.$children.style.zIndex = data.zIndex;
                        gui.$children.style.position = 'relative';
                        gui.domElement.parentElement.style.zIndex = this.baseZIndex;
                    } else {
                        // Base z-index goes to div
                        gui.domElement.parentElement.style.zIndex = data.zIndex;
                        gui.$children.style.zIndex = '';
                        gui.$children.style.position = '';
                    }
                } else {
                    gui.domElement.parentElement.style.zIndex = this.baseZIndex;
                    gui.$children.style.zIndex = '';
                    gui.$children.style.position = '';
                }
                gui.mode = data.mode;
                gui.lockOpenClose = data.lockOpenClose;
                if (gui.lockOpenClose) {
                    // really we only lock them open
                    gui.lockOpenClose = false;
                    gui.open();
                    gui.lockOpenClose = true;
                }
                // Apply mode-specific styling
                this.applyModeStyles(gui);
                
                // Collect sidebar menus to add in correct order
                if (data.mode === "SIDEBAR_LEFT") {
                    leftSidebarMenusToAdd.push({ gui, index: data.sidebarIndex ?? 0 });
                } else if (data.mode === "SIDEBAR_RIGHT") {
                    rightSidebarMenusToAdd.push({ gui, index: data.sidebarIndex ?? 0 });
                } else if (data.mode === "SIDEBAR_CENTER") {
                    centerSidebarMenusToAdd.push({ gui, index: data.sidebarIndex ?? 0 });
                }

                // Restore each submenu's open/closed state. Top-level slots
                // are intentionally always closed (see above), but the user's
                // expanded subfolders (Export > Orbit Image Set, etc.) should
                // survive a save/reload round-trip. This also re-tears-out any
                // folders the user had dragged into floating / sidebar windows.
                this._applyFolderStates(gui, data.folders, sidebarCollections);
            }
        }
        
        // Sort by sidebar index and add to sidebars
        leftSidebarMenusToAdd.sort((a, b) => a.index - b.index);
        rightSidebarMenusToAdd.sort((a, b) => a.index - b.index);
        
        for (const { gui } of leftSidebarMenusToAdd) {
            addMenuToLeftSidebar(gui);
        }
        for (const { gui } of rightSidebarMenusToAdd) {
            addMenuToRightSidebar(gui);
        }

        centerSidebarMenusToAdd.sort((a, b) => a.index - b.index);
        for (const { gui } of centerSidebarMenusToAdd) {
            const dividerFraction = this._computeDividerFraction() ?? 0.5;
            addMenuToCenterSidebar(gui, dividerFraction);
        }

        this.hideEmpty();
        } finally {
            this._folderBatchDepth--;
        }
    }

    // Create a standalone pop-up menu that can be dragged around
    // Returns a GUI object that behaves like the individual menus from the menu bar
    // but is not attached to the menu bar itself
    // dismissOnOutsideClick: if true, clicking outside the menu will dismiss it (for context menus)
    createStandaloneMenu(title, x = 100, y = 100, dismissOnOutsideClick = false) {
        // If a persistent menu is already open, don't allow creating new context menus
        // This prevents right-clicking from opening menus while editing
        if (this.activePersistentMenu && dismissOnOutsideClick) {
            console.log(`Cannot create context menu "${title}" - persistent menu "${this.activePersistentMenu.$title.textContent}" is open`);
            return null;
        }

        // Hard rule: only one context menu visible at once
        // If creating a new context menu, dismiss any existing context menu first
        if (dismissOnOutsideClick && this.activeContextMenu) {
            this.activeContextMenu.destroy();
            this.activeContextMenu = null;
        }

        // Create a container div for the standalone menu
        const containerDiv = document.createElement("div");
        containerDiv.style.position = "absolute";
        containerDiv.style.left = x + "px";
        containerDiv.style.top = y + "px";
        containerDiv.style.zIndex = this.baseZIndex + 1000; // Higher than menu bar items
        this._markMenuSurface(containerDiv);
        containerDiv.style.width = "240px"; // Default lil-gui width
        containerDiv.style.height = "auto";

        // Add to the menu bar container so it's managed by the same system
        this.menuBar.appendChild(containerDiv);

        // Create the GUI with the container
        const gui = new GUI({ container: containerDiv, autoPlace: false });
        gui.$title.innerHTML = title;

        // Set up the standalone menu properties
        gui.mode = "DETACHED";
        // Lock standalone menus open - they should only be closed by dragging back to menubar or other explicit actions
        gui.lockOpenClose = true;
        gui.originalLeft = x;
        gui.originalTop = y;

        // Mark if this is a persistent menu (doesn't dismiss on outside click)
        gui.isPersistent = !dismissOnOutsideClick;

        // If this is a persistent menu, track it as the active persistent menu
        if (gui.isPersistent) {
            // Close any existing persistent menu before opening a new one
            if (this.activePersistentMenu) {
                this.activePersistentMenu.destroy();
            }
            this.activePersistentMenu = gui;
        } else {
            // If this is a context menu, track it as the active context menu
            this.activeContextMenu = gui;
        }

        // Apply detached styling
        this.applyModeStyles(gui);

        // Prevent double clicks
        preventDoubleClicks(gui);

        // Add mouse tracking to disable keyboard shortcuts
        addGUIMouseTracking(gui);

        // Enable double-click on title to close menu (can be overridden with setDoubleClickAction)
        gui.setDoubleClickAction();

        // Add drag functionality to the title (with sidebar docking support)
        gui.$title.addEventListener("mousedown", (event) => {
            this.bringToFront(gui);

            const startX = event.clientX;
            const startY = event.clientY;
            let mouseX = event.clientX;
            let mouseY = event.clientY;
            let hasDragged = false;

            const wasInLeftSidebar = isInLeftSidebar(gui);
            const wasInRightSidebar = isInRightSidebar(gui);
            const wasInCenterSidebar = isInCenterSidebar(gui);
            let hasUndockedFromSidebar = false;

            const divRect = containerDiv.getBoundingClientRect();
            const menuBarRect = this.menuBar.getBoundingClientRect();
            const dragOffsetX = event.clientX - divRect.left;
            const dragOffsetY = event.clientY - divRect.top;

            if (!(wasInLeftSidebar || wasInRightSidebar || wasInCenterSidebar)) {
                gui.mode = "DRAGGING";
                this.applyModeStyles(gui);

                if (gui._closed) {
                    gui.lockOpenClose = false;
                    gui.open();
                }
                gui.lockOpenClose = true;
            }

            const boundHandleMouseMove = (event) => {
                const dx = Math.abs(event.clientX - startX);
                const dy = Math.abs(event.clientY - startY);
                if (dx > 10 || dy > 10) {
                    hasDragged = true;
                }

                if ((wasInLeftSidebar || wasInRightSidebar || wasInCenterSidebar) && !hasUndockedFromSidebar && hasDragged) {
                    this.menuBar.appendChild(containerDiv);
                    this._markMenuSurface(containerDiv);
                    containerDiv.style.position = 'absolute';
                    containerDiv.style.left = (event.clientX - dragOffsetX - menuBarRect.left) + 'px';
                    containerDiv.style.top = (event.clientY - dragOffsetY - menuBarRect.top) + 'px';
                    containerDiv.style.width = '240px';
                    containerDiv.style.height = 'auto';

                    gui.domElement.style.position = '';
                    gui.domElement.style.width = '';

                    if (wasInLeftSidebar) {
                        removeMenuFromLeftSidebar(gui);
                    } else if (wasInRightSidebar) {
                        removeMenuFromRightSidebar(gui);
                    } else {
                        removeMenuFromCenterSidebar(gui);
                    }
                    hasUndockedFromSidebar = true;

                    gui.mode = "DRAGGING";
                    this.applyModeStyles(gui);
                    gui.lockOpenClose = true;

                    event.preventDefault();
                    return;
                }

                if (!hasUndockedFromSidebar && (wasInLeftSidebar || wasInRightSidebar || wasInCenterSidebar)) {
                    return;
                }

                containerDiv.style.left = (parseInt(containerDiv.style.left) + event.clientX - mouseX) + "px";
                containerDiv.style.top = (parseInt(containerDiv.style.top) + event.clientY - mouseY) + "px";
                mouseX = event.clientX;
                mouseY = event.clientY;

                // Check if menu is >80% off-screen during drag - close it
                if (this.isMenuOffScreen(containerDiv)) {
                    document.removeEventListener("mousemove", boundHandleMouseMove);
                    document.removeEventListener("mouseup", boundHandleMouseUp);
                    this._hideDropIndicators();
                    gui.destroy();
                    return;
                }

                const viewportWidth = window.innerWidth;
                const menuLeft = parseInt(containerDiv.style.left);
                const menuRight = menuLeft + gui.domElement.offsetWidth;

                if (menuLeft < 0) {
                    this._showDropIndicator('left');
                } else if (menuRight > viewportWidth) {
                    this._showDropIndicator('right');
                } else if (this._isNearCenterDivider(event.clientX)) {
                    this._showDropIndicator('center');
                } else {
                    this._hideDropIndicators();
                }

                event.preventDefault();
            };

            const boundHandleMouseUp = (event) => {
                document.removeEventListener("mousemove", boundHandleMouseMove);
                document.removeEventListener("mouseup", boundHandleMouseUp);
                this._hideDropIndicators();

                if ((wasInLeftSidebar || wasInRightSidebar || wasInCenterSidebar) && !hasUndockedFromSidebar) {
                    event.preventDefault();
                    return;
                }

                const viewportWidth = window.innerWidth;
                const menuLeft = parseInt(containerDiv.style.left);
                const menuRight = menuLeft + gui.domElement.offsetWidth;

                if (hasDragged && menuLeft < 0) {
                    addMenuToLeftSidebar(gui);
                    gui.mode = "SIDEBAR_LEFT";
                    gui.lockOpenClose = false;
                    gui.open();
                    gui.lockOpenClose = true;
                    this.applyModeStyles(gui);
                    event.preventDefault();
                    return;
                }

                if (hasDragged && menuRight > viewportWidth) {
                    addMenuToRightSidebar(gui);
                    gui.mode = "SIDEBAR_RIGHT";
                    gui.lockOpenClose = false;
                    gui.open();
                    gui.lockOpenClose = true;
                    this.applyModeStyles(gui);
                    event.preventDefault();
                    return;
                }

                if (hasDragged && this._isNearCenterDivider(event.clientX)) {
                    const dividerFraction = this._computeDividerFraction();
                    if (dividerFraction !== null) {
                        addMenuToCenterSidebar(gui, dividerFraction);
                        gui.mode = "SIDEBAR_CENTER";
                        gui.lockOpenClose = false;
                        gui.open();
                        gui.lockOpenClose = true;
                        this.applyModeStyles(gui);
                        event.preventDefault();
                        return;
                    }
                }

                // Check if menu ended up >80% off-screen - close it
                if (this.isMenuOffScreen(containerDiv)) {
                    gui.destroy();
                    event.preventDefault();
                    return;
                }

                gui.mode = "DETACHED";
                this.applyModeStyles(gui);
                // Keep locked open after drag
                gui.lockOpenClose = true;

                event.preventDefault();
            };

            document.addEventListener("mousemove", boundHandleMouseMove);
            document.addEventListener("mouseup", boundHandleMouseUp);

            event.preventDefault();
        });

        // Add click listener to bring to front when any part is clicked
        gui.domElement.addEventListener("mousedown", (event) => {
            this.bringToFront(gui);
        });

        // Store method to bring this standalone menu to front
        gui._bringToFront = () => {
            let maxZIndex = this.baseZIndex + 1000;

            // Check all standalone menus and regular menu bar items
            const allContainers = Array.from(this.menuBar.children);
            for (const container of allContainers) {
                if (container !== containerDiv) {
                    const zIndex = parseInt(container.style.zIndex);
                    if (zIndex > maxZIndex) {
                        maxZIndex = zIndex;
                    }
                }
            }

            containerDiv.style.zIndex = maxZIndex + 1;
        };

        // Store reference to container for cleanup
        gui._standaloneContainer = containerDiv;

        // Store reference from container to GUI for click-outside detection
        containerDiv._gui = gui;

        // Add destroy method override to clean up the container
        const originalDestroy = gui.destroy.bind(gui);
        gui.destroy = (all = true, skipEditModeDisable = false) => {
            // Find and disable any "editMode" controllers before destroying
            // This ensures edit mode is properly exited when the menu is closed
            // Skip this when just relocating the menu (skipEditModeDisable = true)
            if (!skipEditModeDisable) {
                // Set global flag so setEditMode knows not to try destroying the menu (prevents recursion)
                window._menuBeingDestroyed = true;
                const findEditModeControllers = (folder) => {
                    for (const child of folder.children) {
                        if (child.controllers) {
                            // It's a folder, recurse
                            findEditModeControllers(child);
                        } else if (child.property === 'editMode' && child.getValue() === true) {
                            // It's an editMode controller that's enabled - disable it
                            child.setValue(false);
                        }
                    }
                };
                findEditModeControllers(gui);
                window._menuBeingDestroyed = false;
            }

            // Remove from sidebar if docked there
            if (isInLeftSidebar(gui)) {
                removeMenuFromLeftSidebar(gui);
            }
            if (isInRightSidebar(gui)) {
                removeMenuFromRightSidebar(gui);
            }
            
            if (containerDiv.parentElement) {
                containerDiv.parentElement.removeChild(containerDiv);
            }
            // Remove the escape key listener
            if (gui._escapeKeyHandler) {
                document.removeEventListener('keydown', gui._escapeKeyHandler);
            }
            // Remove the outside click listener if it exists
            if (gui._outsideClickHandler) {
                document.removeEventListener('click', gui._outsideClickHandler);
            }
            // Remove the outside contextmenu listener if it exists
            if (gui._outsideContextMenuHandler) {
                document.removeEventListener('contextmenu', gui._outsideContextMenuHandler);
            }
            // Clear the active persistent menu reference if this was it
            if (gui.isPersistent && this.activePersistentMenu === gui) {
                this.activePersistentMenu = null;
            }
            // Clear the active context menu reference if this was it
            if (!gui.isPersistent && this.activeContextMenu === gui) {
                this.activeContextMenu = null;
            }
            // Reset mouseOverGUI flag to ensure keyboard controls work after menu is closed
            setMouseOverGUI(false);
            originalDestroy(all);
        };

        // Add Escape key handler to close the menu
        gui._escapeKeyHandler = (event) => {
            if (event.key === 'Escape' && containerDiv.parentElement) {
                // Check if this menu is the topmost one
                let maxZIndex = -Infinity;
                let topmostMenu = null;
                const allContainers = Array.from(this.menuBar.children);
                for (const container of allContainers) {
                    if (container._gui && container._gui._standaloneContainer) {
                        const zIndex = parseInt(container.style.zIndex);
                        if (zIndex > maxZIndex) {
                            maxZIndex = zIndex;
                            topmostMenu = container._gui;
                        }
                    }
                }

                // Only close if this is the topmost menu
                if (topmostMenu === gui) {
                    gui.destroy();
                }
            }
        };
        document.addEventListener('keydown', gui._escapeKeyHandler);

        // Add outside click handler if requested (for context menus)
        if (dismissOnOutsideClick) {
            // Helper function to check if click is outside the menu
            const isClickOutside = (event) => {
                // Walk up the DOM tree to see if we're inside this menu or any GUI element
                let element = event.target;
                while (element) {
                    // If we find our container, the click is inside the menu
                    if (element === containerDiv) {
                        return false;
                    }
                    // If we find any lil-gui element, the click is on a GUI element
                    if (element.classList && element.classList.contains('lil-gui')) {
                        return false;
                    }
                    element = element.parentElement;
                }
                return true;
            };

            // Left-click handler: dismiss on outside click
            gui._outsideClickHandler = (event) => {
                if (isClickOutside(event) && containerDiv.parentElement) {
                    gui.destroy();
                }
            };

            // Right-click handler: dismiss on outside right-click (allows new context menu to be created)
            gui._outsideContextMenuHandler = (event) => {
                if (isClickOutside(event) && containerDiv.parentElement) {
                    gui.destroy();
                    // Don't preventDefault - let the application handle the right-click to create new menu
                }
            };

            // Use setTimeout to avoid immediately triggering on the same click that created the menu
            setTimeout(() => {
                document.addEventListener('click', gui._outsideClickHandler);
                document.addEventListener('contextmenu', gui._outsideContextMenuHandler);
            }, 100);
        }

        // Ensure the menu is fully on screen
        this.ensureMenuOnScreen(containerDiv);

        return gui;
    }


}

// Import for side effects (NumberController prototype patches apply at import
// time) and re-export setupHelpSearch so index.js keeps importing from this
// file.
export {setupHelpSearch} from "./lil-gui-slider-settings";
