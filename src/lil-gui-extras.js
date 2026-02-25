// Helper functions for lil-gui
import GUI, {Controller, NumberController} from "./js/lil-gui.esm";
//import {updateSize} from "./JetStuff";
import {Globals, setMouseOverGUI, Units} from "./Globals";
import {Color} from "three";
import {assert} from "./assert";
import {ViewMan} from "./CViewManager";
import {parseBoolean} from "./utils";
import Stats from "stats.js";
import {
    addMenuToLeftSidebar,
    addMenuToRightSidebar,
    getLeftSidebar,
    getLeftSidebarMenuIndex,
    getRightSidebar,
    getRightSidebarMenuIndex,
    isInLeftSidebar,
    isInRightSidebar,
    removeMenuFromLeftSidebar,
    removeMenuFromRightSidebar,
    toggleControlsVisibility
} from "./PageStructure";

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
    $option.innerHTML = optionName;
    $option.value = optionValue;

    // Append the new option to the select element
    controller.$select.appendChild($option);

    // Update the display
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

        // Update the display
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
    // Find the child GUI with the specified title
    const folder = this.children.find(child => child instanceof GUI && child.$title.innerText === title);

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

    return this; // Return the controller to allow method chaining
};

// adding a tooltip to a controller
Controller.prototype.tooltip = function (tooltip) {
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

    // Update the display
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

// Folder tooltip
GUI.prototype.tooltip = function (tooltip) {
    this.domElement.title = tooltip;
    return this; // Return the controller to allow method chaining
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

        this.barHeight = 25; // height of the menu bar

        // Z-index management for bringing clicked menus to front
        this.baseZIndex = 5000; // Base z-index for menu divs

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
        this.menuBar.style.overflowY = "auto"; // Allow scrolling if content overflows
        this.menuBar.style.overflowX = "hidden"; // Prevent horizontal scrollbar when dragging menus

        this._hidden = false;

        // add the menuBar to the document body
        document.body.appendChild(this.menuBar);

        // add a black bar div, with a grey 1 pixel border
        const bar = document.createElement("div");
        bar.style.position = "absolute";
        bar.style.top = "0px";
        if (parseBoolean(process.env.BANNER_ACTIVE)) {
            bar.style.top = process.env.BANNER_HEIGHT + "px";
            this.menuBar.style.top = process.env.BANNER_HEIGHT + "px";
        }

        bar.style.left = "0px";
        bar.style.height = this.barHeight + "px"; // one pixel more than the menu title divs
        bar.style.width = "100%";
        bar.style.backgroundColor = "black";
        bar.style.borderBottom = "1px solid grey";
        bar.style.zIndex = 400; // behind the other menus
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

            this.menuBar.appendChild(div);
            this.divs.push(div);
        }

        this.nextSlot = 0; // next slot to be filled

        // add an info GUI in the top right
        this.infoGUI = new GUI().title("Sitrec").close()
        // move it down if there is a banner
        if (parseBoolean(process.env.BANNER_ACTIVE)) {
            this.infoGUI.domElement.style.top = process.env.BANNER_HEIGHT + "px";
        }

        // Prevent browser context menu on right-click for info GUI
        this.infoGUI.domElement.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();
        });

        Globals.stats = new Stats();
        // Globals.stats.showPanel( 1 ); // 0: fps, 1: ms, 2: mb, 3+: custom
        // const attach = this.infoGUI.domElement;
        //
        // attach.appendChild( Globals.stats.dom );


    }

    // Bring a menu to the front by updating its z-index
    bringToFront(gui) {
        if (gui._standaloneContainer) {
            // This is a standalone menu
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
        gui.$children.style.zIndex = '';
        gui.$children.style.position = '';
    }



    updateListeners() {

        this.hideEmpty();


        this.slots.forEach((gui) => {
            gui.updateListeners();
        })
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
        const topOffset = (isFullScreen && !parseBoolean(process.env.BANNER_ACTIVE)) ? 10 : 0;

        if (parseBoolean(process.env.BANNER_ACTIVE)) {
            // With banner, position below it
            this.bar.style.top = process.env.BANNER_HEIGHT + "px";
            this.menuBar.style.top = process.env.BANNER_HEIGHT + "px";
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
        } else {
            this._dropIndicator.style.right = '0';
            if (rightSidebar && rightSidebar.style.display !== 'none') {
                this._dropIndicator.style.width = rightSidebar.offsetWidth + 'px';
                this._dropIndicator.style.backgroundColor = 'transparent';
                this._dropIndicator.style.border = '2px solid rgba(100, 150, 255, 0.8)';
            }
        }
        
        this._dropIndicator.style.display = 'block';
    }
    
    _hideDropIndicators() {
        if (this._dropIndicator) {
            this._dropIndicator.style.display = 'none';
        }
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
        this.slots.forEach((gui) => {
            this.restoreToBar(gui);
            gui.close();
        })
    }

    // Check if a GUI folder has any actual content (recursively)
    _hasContent(gui) {
        if (!gui) return false;

        for (const child of gui.children) {
            // If it's a folder (GUI), recursively check its content
            if (child instanceof GUI) {
                if (this._hasContent(child)) return true;
            } else {
                // It's a controller, so this GUI has content
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

                // Check if the GUI has any actual content (recursively)
                const hasContent = this._hasContent(gui);

                if (!hasContent) {
                    // Empty menu - close and hide it
                    gui.close();
                    div.style.display = "none";
                } else {
                    // Has content - make sure it's visible
                    div.style.display = "block";
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
                if (newGUI.children.length === 1 && newGUI.children[0].constructor.name === "GUI") {
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

        // Prevent browser context menu on right-click
        newGUI.domElement.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();
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

        newGUI.domElement.style.position = '';
        newGUI.domElement.style.width = '';
        newGUI.$children.style.zIndex = '';
        newGUI.$children.style.position = '';
        newGUI.lockOpenClose = false;
        newGUI.mode = "DOCKED";

        this.applyModeStyles(newGUI);
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

    applyModeStyles(gui) {
        const titleElement = gui.$title;

        if (gui.mode === "DOCKED" || gui.mode === "SIDEBAR_LEFT" || gui.mode === "SIDEBAR_RIGHT") {
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

        this.bringToFront(newGUI);

        const newDiv = this.divs.find((div) => div === newGUI.domElement.parentElement);

        const startX = event.clientX;
        const startY = event.clientY;
        let hasDragged = false;

        const wasInLeftSidebar = isInLeftSidebar(newGUI);
        const wasInRightSidebar = isInRightSidebar(newGUI);
        let hasUndockedFromSidebar = false;
        
        const divRect = newDiv.getBoundingClientRect();
        const menuBarRect = this.menuBar.getBoundingClientRect();
        const dragOffsetX = event.clientX - divRect.left;
        const dragOffsetY = event.clientY - divRect.top;

        if (!(wasInLeftSidebar || wasInRightSidebar)) {
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
            if (dx > 10 || dy > 10) {
                hasDragged = true;
            }
            
            if ((wasInLeftSidebar || wasInRightSidebar) && !hasUndockedFromSidebar && hasDragged) {
                this.menuBar.appendChild(newDiv);
                newDiv.style.position = 'absolute';
                newDiv.style.left = (event.clientX - dragOffsetX - menuBarRect.left) + 'px';
                newDiv.style.top = (event.clientY - dragOffsetY - menuBarRect.top) + 'px';
                newDiv.style.width = '';
                newDiv.style.height = '1px';
                
                newGUI.domElement.style.position = '';
                newGUI.domElement.style.width = '';
                
                if (wasInLeftSidebar) {
                    removeMenuFromLeftSidebar(newGUI);
                } else {
                    removeMenuFromRightSidebar(newGUI);
                }
                hasUndockedFromSidebar = true;
                
                newGUI.mode = "DRAGGING"
                this.applyModeStyles(newGUI)
                newGUI.lockOpenClose = true;
                
                event.preventDefault();
                return;
            }
            
            if (!hasUndockedFromSidebar && (wasInLeftSidebar || wasInRightSidebar)) {
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

            if ((wasInLeftSidebar || wasInRightSidebar) && !hasUndockedFromSidebar) {
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
                event.preventDefault();
                return;
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
        return this.slots[slot].$title.innerHTML
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
            };
            if (gui.mode === "SIDEBAR_LEFT") {
                serialized.sidebarIndex = getLeftSidebarMenuIndex(gui);
            } else if (gui.mode === "SIDEBAR_RIGHT") {
                serialized.sidebarIndex = getRightSidebarMenuIndex(gui);
            }
            out[this.getSerialID(i)] = serialized;
        }

        return out;
    }


    modDeserialize(v) {
        const guiData = v;
        const leftSidebarMenusToAdd = [];
        const rightSidebarMenusToAdd = [];

        for (let i = 0; i < this.slots.length; i++) {
            const key = this.getSerialID(i);
            if (v[key] !== undefined) {
                const gui = this.slots[i];
                const data = guiData[key];
                // When loading a sitch, all docked menus should be closed
                // Ignore the serialized closed state and always close menus
                // This ensures the internal _closed state matches the DOM (closed class and aria-expanded attribute)
                gui.close();
                gui.domElement.parentElement.style.left = data.left;
                gui.domElement.parentElement.style.top = data.top;
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
                }
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
            let hasUndockedFromSidebar = false;

            const divRect = containerDiv.getBoundingClientRect();
            const menuBarRect = this.menuBar.getBoundingClientRect();
            const dragOffsetX = event.clientX - divRect.left;
            const dragOffsetY = event.clientY - divRect.top;

            if (!(wasInLeftSidebar || wasInRightSidebar)) {
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

                if ((wasInLeftSidebar || wasInRightSidebar) && !hasUndockedFromSidebar && hasDragged) {
                    this.menuBar.appendChild(containerDiv);
                    containerDiv.style.position = 'absolute';
                    containerDiv.style.left = (event.clientX - dragOffsetX - menuBarRect.left) + 'px';
                    containerDiv.style.top = (event.clientY - dragOffsetY - menuBarRect.top) + 'px';
                    containerDiv.style.width = '240px';
                    containerDiv.style.height = 'auto';

                    gui.domElement.style.position = '';
                    gui.domElement.style.width = '';

                    if (wasInLeftSidebar) {
                        removeMenuFromLeftSidebar(gui);
                    } else {
                        removeMenuFromRightSidebar(gui);
                    }
                    hasUndockedFromSidebar = true;

                    gui.mode = "DRAGGING";
                    this.applyModeStyles(gui);
                    gui.lockOpenClose = true;

                    event.preventDefault();
                    return;
                }

                if (!hasUndockedFromSidebar && (wasInLeftSidebar || wasInRightSidebar)) {
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
                } else {
                    this._hideDropIndicators();
                }

                event.preventDefault();
            };

            const boundHandleMouseUp = (event) => {
                document.removeEventListener("mousemove", boundHandleMouseMove);
                document.removeEventListener("mouseup", boundHandleMouseUp);
                this._hideDropIndicators();

                if ((wasInLeftSidebar || wasInRightSidebar) && !hasUndockedFromSidebar) {
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

        // Prevent browser context menu on right-click
        gui.domElement.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();
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

const textWidths = {};

function openSliderSettingsMenu(controller, event) {
    if (!Globals.menuBar) return;

    // For log sliders, convert from log space back to real space for display/editing
    const isLogSlider = controller._isLog;
    // Current min/max (what the slider is currently set to)
    const currentMin = isLogSlider ? Math.pow(10, controller._min) : controller._min;
    const currentMax = isLogSlider ? Math.pow(10, controller._max) : controller._max;
    const currentStep = controller._step;
    // Original min/max (never changes, used for slider range)
    const originalMin = isLogSlider ? Math.pow(10, controller._originalMin) : controller._originalMin;
    const originalMax = isLogSlider ? Math.pow(10, controller._originalMax) : controller._originalMax;
    const originalStep = controller._step;

    // Highlight the controller being edited
    const originalBackground = controller.domElement.style.backgroundColor;
    controller.domElement.style.backgroundColor = 'yellow';

    const restoreBackground = () => {
        controller.domElement.style.backgroundColor = originalBackground;
    };

    // Calculate position: prefer right side of parent menu, fallback to left
    const controllerRect = controller.domElement.getBoundingClientRect();
    const parentRect = controller.parent.root.domElement.getBoundingClientRect();
    const menuWidth = 240; // Default lil-gui width
    const menuHeight = 180; // Approximate height for slider settings menu
    const padding = 5;

    let x, y;
    
    // Try right side first
    if (parentRect.right + padding + menuWidth <= window.innerWidth) {
        x = parentRect.right + padding;
    } else {
        // Fall back to left side
        x = parentRect.left - menuWidth - padding;
    }
    
    // Vertically align with the slider
    y = controllerRect.top;
    
    // Adjust if it goes off the bottom
    if (y + menuHeight > window.innerHeight) {
        y = window.innerHeight - menuHeight - padding;
    }
    
    // Ensure it doesn't go above the top
    if (y < 0) {
        y = padding;
    }

    const menu = Globals.menuBar.createStandaloneMenu(
        controller._name,
        x,
        y,
        false
    );

    if (!menu) {
        restoreBackground();
        return;
    }

    // Store reference to parent GUI so we can close this when the parent is closed/redocked
    menu._parentGUI = controller.parent.root;

    // Wrap destroy to ensure background is restored regardless of how menu is closed
    const originalDestroy = menu.destroy.bind(menu);
    menu.destroy = () => {
        restoreBackground();
        originalDestroy();
    };

    const settings = {
        min: currentMin,
        max: currentMax,
        stepExp: Math.log10(currentStep),
        reset: () => {
            settings.min = originalMin;
            settings.max = originalMax;
            settings.stepExp = Math.log10(originalStep);
            controller.min(isLogSlider ? Math.log10(originalMin) : originalMin);
            controller.max(isLogSlider ? Math.log10(originalMax) : originalMax);
            controller.step(originalStep);
            controller.updateDisplay();
            minController.updateDisplay();
            maxController.updateDisplay();
            stepController.updateDisplay();
        },
        done: () => {
            menu.destroy();
        }
    };

    const LOG_ZERO_THRESHOLD = 1e-4;
    const sliderRangeMax = controller._maxMax ?? Math.max(originalMax, currentMax);
    
    const minController = menu.add(settings, 'min', LOG_ZERO_THRESHOLD, sliderRangeMax, 0.0001)
        .name('Min')
        .isLog(true)
        .displayZeroThreshold(LOG_ZERO_THRESHOLD)
        .onChange(v => {
        const actualValue = v <= LOG_ZERO_THRESHOLD ? 0 : v;
        controller.min(isLogSlider ? (actualValue === 0 ? -Infinity : Math.log10(actualValue)) : actualValue);
        controller.updateDisplay();
    });

    const maxController = menu.add(settings, 'max', LOG_ZERO_THRESHOLD, sliderRangeMax, 0.0001)
        .name('Max')
        .isLog(true)
        .displayZeroThreshold(LOG_ZERO_THRESHOLD)
        .onChange(v => {
        const actualValue = v <= LOG_ZERO_THRESHOLD ? 0 : v;
        controller.max(isLogSlider ? (actualValue === 0 ? -Infinity : Math.log10(actualValue)) : actualValue);
        controller.updateDisplay();
    });

    const stepController = menu.add(settings, 'stepExp', -5, 2, 1)
        .name('Step')
        .isLog()
        .onChange(v => {
        controller.step(v);
    });

    menu.add(settings, 'reset').name('Reset');
    menu.add(settings, 'done').name('Done').setDoubleClickAction();
}

NumberController.prototype.isLog = function(convertRange = false) {
    this._isLog = true;
    if (convertRange) {
        const safeMin = Math.max(this._min, 1e-10);
        const safeMax = Math.max(this._max, 1e-10);
        const safeValue = Math.max(this.object[this.property], 1e-10);
        this._min = Math.log10(safeMin);
        this._max = Math.log10(safeMax);
        this.object[this.property] = Math.log10(safeValue);
    }
    this.updateDisplay();
    return this;
};

NumberController.prototype.getLogValue = function() {
    const linearValue = this.object[this.property];
    return this._isLog ? Math.pow(10, linearValue) : linearValue;
};

const originalGetValue = NumberController.prototype.getValue;
NumberController.prototype.getValue = function() {
    if (this._isLog) {
        return this.getLogValue();
    }
    return originalGetValue.call(this);
};

NumberController.prototype.displayZeroThreshold = function(threshold) {
    this._displayZeroThreshold = threshold;
    return this;
};

const originalUpdateDisplay = NumberController.prototype.updateDisplay;
NumberController.prototype.updateDisplay = function() {
    if (this._isLog) {
        const linearValue = this.object[this.property];
        
        if (this.$fill) {
            let percent = (linearValue - this._min) / (this._max - this._min);
            percent = Math.max(0, Math.min(percent, 1));
            this.$fill.style.width = percent * 100 + '%';
        }
        
        if (!this._inputFocused) {
            const logValue = Math.pow(10, linearValue);
            if (this._displayZeroThreshold !== undefined && logValue <= this._displayZeroThreshold) {
                this.$input.value = '0';
            } else {
                this.$input.value = this._decimals === undefined ? logValue : logValue.toFixed(this._decimals);
            }
        }
        
        return this;
    }
    return originalUpdateDisplay.call(this);
};

const originalInitSlider = NumberController.prototype._initSlider;
NumberController.prototype._initSlider = function() {
    originalInitSlider.call(this);

    const handleRightClick = (e) => {
        if (e.button === 2) {
            e.preventDefault();
            e.stopPropagation();
            // Don't open slider settings for sliders inside a standalone menu (like the slider settings menu itself)
            if (this.parent.root._standaloneContainer) return;
            openSliderSettingsMenu(this, e);
        }
    };

    if (this.$slider) {
        this.$slider.addEventListener('mousedown', handleRightClick);
    }
    
    // Also allow right-click on the name/label
    this.$name.addEventListener('mousedown', handleRightClick);
};

// text width helper function
// assumes the default lil-gui font
function getTextWidth(text) {
    // cache values, as it's an expensive calculation
    if (textWidths[text] !== undefined) {
        return textWidths[text];
    }
    // Create a temporary element
    const element = document.createElement('span');
    // Apply styles from the stylesheet
    element.style.fontFamily = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif`;
    element.style.fontSize = `11px`;
    element.style.fontWeight = `normal`;
    element.style.fontStyle = `normal`;
    element.style.lineHeight = `1`;
    // Add text to the element
    element.innerText = text;
    // Append to the body to measure
    document.body.appendChild(element);
    // Measure width
    const width = element.offsetWidth;
    // Remove the temporary element
    document.body.removeChild(element);
    textWidths[text] = width;
    return width;
}

export function setupHelpSearch(helpMenu) {
    if (!helpMenu || !Globals.menuBar) return;

    const searchContainer = document.createElement('div');
    searchContainer.style.cssText = 'padding: 4px; border-bottom: 1px solid #444;';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search menus...';
    searchInput.style.cssText = 'width: 100%; box-sizing: border-box; padding: 4px 8px; border: 1px solid #555; border-radius: 3px; background: #2a2a2a; color: #eee; font-size: 11px;';

    const resultsContainer = document.createElement('div');
    resultsContainer.style.cssText = 'max-height: 300px; overflow-y: auto;';

    searchContainer.appendChild(searchInput);
    searchContainer.appendChild(resultsContainer);

    helpMenu.$children.insertBefore(searchContainer, helpMenu.$children.firstChild);

    let currentHighlight = null;
    let highlightTimeout = null;
    let hoverOpenedMenu = null;
    let selectedIndex = -1;
    let currentMatches = [];

    function clearHighlight() {
        if (currentHighlight) {
            currentHighlight.style.backgroundColor = '';
            currentHighlight = null;
        }
        if (highlightTimeout) {
            clearTimeout(highlightTimeout);
            highlightTimeout = null;
        }
    }

    function highlightController(controller, duration = 0) {
        clearHighlight();
        controller.domElement.style.backgroundColor = 'yellow';
        currentHighlight = controller.domElement;
        if (duration > 0) {
            highlightTimeout = setTimeout(clearHighlight, duration);
        }
    }

    function getMenuPath(gui) {
        const path = [];
        let current = gui;
        while (current && current.$title) {
            const title = current.$title.innerText;
            if (title) path.unshift(title);
            current = current.parent;
        }
        return path;
    }

    function collectMenuItems() {
        const items = [];
        const menuBar = Globals.menuBar;

        for (const slot of menuBar.slots) {
            if (!slot) continue;
            collectFromGUI(slot, items);
        }
        return items;
    }

    function collectFromGUI(gui, items, depth = 0) {
        if (!gui || !gui.children) return;

        for (const child of gui.children) {
            if (child instanceof GUI) {
                collectFromGUI(child, items, depth + 1);
            } else if (child._name) {
                const path = getMenuPath(gui);
                items.push({
                    name: child._name,
                    path: path,
                    controller: child,
                    gui: gui,
                    rootMenu: findRootMenu(gui)
                });
            }
        }
    }

    function findRootMenu(gui) {
        let current = gui;
        while (current.parent && current.parent.$title) {
            current = current.parent;
        }
        return current;
    }

    function openMenuChain(gui, keepHelpOpen = false) {
        const chain = [];
        let current = gui;
        while (current) {
            chain.unshift(current);
            current = current.parent;
        }
        if (keepHelpOpen) {
            helpMenu.lockOpenClose = true;
        }
        try {
            for (const g of chain) {
                if (g.open) g.open();
            }
        } finally {
            if (keepHelpOpen) {
                helpMenu.lockOpenClose = false;
            }
        }
    }

    function clearResultSelection() {
        const results = resultsContainer.children;
        for (let i = 0; i < results.length; i++) {
            results[i].style.backgroundColor = '';
        }
        clearHighlight();
        if (hoverOpenedMenu && hoverOpenedMenu.mode === "DOCKED") {
            hoverOpenedMenu.close();
        }
        hoverOpenedMenu = null;
    }

    function selectResult(index) {
        if (currentMatches.length === 0) return;
        
        clearResultSelection();
        
        if (index < 0) index = currentMatches.length - 1;
        if (index >= currentMatches.length) index = 0;
        selectedIndex = index;
        
        const match = currentMatches[index];
        const resultDiv = resultsContainer.children[index];
        if (resultDiv) {
            resultDiv.style.backgroundColor = '#444';
            resultDiv.scrollIntoView({ block: 'nearest' });
        }
        
        if (match.rootMenu !== helpMenu) {
            openMenuChain(match.gui, true);
            hoverOpenedMenu = match.rootMenu;
            highlightController(match.controller);
        }
    }

    function activateResult(index) {
        if (index < 0 || index >= currentMatches.length) return;
        
        const match = currentMatches[index];
        helpMenu.close();
        
        if (hoverOpenedMenu && hoverOpenedMenu.mode === "DOCKED") {
            hoverOpenedMenu.close();
        }
        
        openMenuChain(match.gui);
        highlightController(match.controller, 5000);
        
        searchInput.value = '';
        resultsContainer.innerHTML = '';
        currentMatches = [];
        selectedIndex = -1;
        hoverOpenedMenu = null;
    }

    function performSearch(query) {
        resultsContainer.innerHTML = '';
        selectedIndex = -1;
        currentMatches = [];
        
        if (!query || query.length < 1) return;

        const items = collectMenuItems();
        const lowerQuery = query.toLowerCase();
        currentMatches = items.filter(item => {
            return item.name.toLowerCase().includes(lowerQuery);
        }).slice(0, 20);

        for (const match of currentMatches) {
            const resultDiv = document.createElement('div');
            resultDiv.style.cssText = 'padding: 4px 8px; cursor: pointer; border-bottom: 1px solid #333; font-size: 11px;';
            resultDiv.innerHTML = `<span style="color: #888;">${match.path.join(' > ')}</span> > <span style="color: #fff;">${match.name}</span>`;
            const tooltip = match.controller.domElement.title;
            if (tooltip) {
                resultDiv.title = tooltip;
            }

            const matchIndex = currentMatches.indexOf(match);
            
            resultDiv.addEventListener('mouseenter', () => {
                selectResult(matchIndex);
            });

            resultDiv.addEventListener('mouseleave', () => {
                resultDiv.style.backgroundColor = '';
                clearHighlight();
            });

            resultDiv.addEventListener('click', () => {
                activateResult(matchIndex);
            });

            resultsContainer.appendChild(resultDiv);
        }
    }

    searchInput.addEventListener('input', (e) => {
        performSearch(e.target.value);
    });

    searchInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectResult(selectedIndex + 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectResult(selectedIndex - 1);
        } else if (e.key === 'Enter' && selectedIndex >= 0) {
            e.preventDefault();
            activateResult(selectedIndex);
        } else if (e.key === 'Escape') {
            clearResultSelection();
            selectedIndex = -1;
        }
    });

    resultsContainer.addEventListener('mouseleave', () => {
        clearHighlight();
        if (hoverOpenedMenu && hoverOpenedMenu.mode === "DOCKED") {
            hoverOpenedMenu.close();
        }
        hoverOpenedMenu = null;
    });

    helpMenu.onOpenClose((gui) => {
        if (gui._closed) {
            searchInput.value = '';
            resultsContainer.innerHTML = '';
            clearHighlight();
            helpMenu.lockOpenClose = false;
            if (hoverOpenedMenu && hoverOpenedMenu.mode === "DOCKED") {
                hoverOpenedMenu.close();
            }
            hoverOpenedMenu = null;
            selectedIndex = -1;
            currentMatches = [];
        }
    });
}

