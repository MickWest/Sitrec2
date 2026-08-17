/**
 * Slider settings popup, NumberController prototype overrides, and the
 * Help-menu search UI.
 *
 * Split out of lil-gui-extras.js to keep the main module focused on GUI
 * scaffolding and the menu-bar class. Runs its prototype patches at import
 * time, so any code that imports lil-gui-extras transitively picks them up.
 */

import {GUI, NumberController} from "./js/lil-gui.esm";
import {Globals} from "./Globals";
import {armBigSlider} from "./BigSlider";

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
        .allowInputExpandMax(true)
        .onChange(v => {
        const actualValue = v <= LOG_ZERO_THRESHOLD ? 0 : v;
        if (controller._maxMax !== undefined && actualValue > controller._maxMax) {
            controller._maxMax = actualValue;
        }
        if (controller.object && typeof controller.object === "object" && controller.object.maxMax !== undefined && actualValue > controller.object.maxMax) {
            controller.object.maxMax = actualValue;
        }
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

// NumberController.updateDisplay used to be overridden here to handle log sliders.
// It no longer needs to be: the base version now asks _fillPercent() for the knob
// position (which reads the raw, log-space value) and displayText() for the input
// text (which honours _displayZeroThreshold), so one implementation covers both.

const originalInitSlider = NumberController.prototype._initSlider;
NumberController.prototype._initSlider = function() {
    originalInitSlider.call(this);
    this._defaultValue = this.object[this.property];

    const handleRightClick = (e) => {
        if (e.button === 2) {
            e.preventDefault();
            e.stopPropagation();
            // Don't open slider settings for sliders inside a standalone menu (like the slider settings menu itself)
            if (this.parent.root._standaloneContainer) return;
            openSliderSettingsMenu(this, e);
        }
    };

    const resetToDefault = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setValue(this._defaultValue);
    };

    const suppressContextMenu = (e) => e.preventDefault();

    if (this.$slider) {
        this.$slider.addEventListener('mousedown', handleRightClick);
        this.$slider.addEventListener('contextmenu', suppressContextMenu);
        // Resting on the slider for a few seconds brings up the full-width version.
        armBigSlider(this);
    }

    // Also allow right-click on the name/label
    this.$name.addEventListener('mousedown', handleRightClick);
    this.$name.addEventListener('dblclick', resetToDefault);
    this.$name.addEventListener('contextmenu', suppressContextMenu);
};

// text width helper function
// assumes the default lil-gui font
export function getTextWidth(text) {
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

    // Flex column with an explicit gap, rather than letting the results sit
    // directly under the input: the input is inline-level by default, so its
    // line box left the first result crowding (and visually overlapping) the
    // input's bottom border.
    const searchContainer = document.createElement('div');
    searchContainer.style.cssText = 'display: flex; flex-direction: column; gap: 6px; '
        + 'padding: 6px; border-bottom: 1px solid #444;';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search menus...';
    searchInput.style.cssText = 'display: block; width: 100%; box-sizing: border-box; margin: 0; '
        + 'padding: 4px 8px; border: 1px solid #555; border-radius: 3px; background: #2a2a2a; '
        + 'color: #eee; font-size: 11px;';

    // display:none while empty so the flex gap does not leave a stray band
    // under the input before anything has been typed.
    const resultsContainer = document.createElement('div');
    resultsContainer.style.cssText = 'display: none; max-height: 300px; overflow-y: auto; '
        + 'border: 1px solid #3a3a3a; border-radius: 3px;';

    searchContainer.appendChild(searchInput);
    searchContainer.appendChild(resultsContainer);

    helpMenu.$children.insertBefore(searchContainer, helpMenu.$children.firstChild);

    let currentHighlight = null;
    let highlightBox = null;
    let highlightPrevPosition = null;
    let highlightTimeout = null;
    let hoverOpenedMenu = null;
    let selectedIndex = -1;
    let currentMatches = [];

    function clearHighlight() {
        if (highlightBox) {
            highlightBox.remove();
            highlightBox = null;
        }
        if (currentHighlight) {
            if (highlightPrevPosition !== null) {
                currentHighlight.style.position = highlightPrevPosition;
                highlightPrevPosition = null;
            }
            currentHighlight = null;
        }
        if (highlightTimeout) {
            clearTimeout(highlightTimeout);
            highlightTimeout = null;
        }
    }

    // Takes the ELEMENT, not the controller: a matched sub-menu has no
    // controller, and the thing to flash for it is its title bar.
    //
    // A BOX, NOT A FILL, AND AN OVERLAY RATHER THAN AN `outline`. A yellow
    // background works on a control row only by accident — its widgets cover
    // most of the row, so the fill survives as slivers down the edges — while
    // on a folder title, which is bare text, the same fill floods the bar and
    // the label becomes unreadable. An `outline` fails differently: a row's
    // .widget spans the full height and paints ABOVE the row's own outline, so
    // the box survived only in the 4px of padding at each end. An absolutely
    // positioned last child paints above the widget, so the box is always
    // complete, costs no layout, and never touches the text.
    function highlightElement(element, duration = 0) {
        clearHighlight();
        if (!element) return;
        // The overlay is positioned against the element itself, so the element
        // has to be a containing block; most menu rows are static.
        if (getComputedStyle(element).position === 'static') {
            highlightPrevPosition = element.style.position;
            element.style.position = 'relative';
        }
        highlightBox = document.createElement('div');
        highlightBox.style.cssText = 'position: absolute; inset: 0; '
            + 'border: 2px solid yellow; border-radius: 2px; '
            + 'pointer-events: none; z-index: 5;';
        element.appendChild(highlightBox);
        currentHighlight = element;
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

    function folderItem(folder, parentGui) {
        const title = folder.$title ? folder.$title.innerText : '';
        if (!title) return null;
        return {
            name: title,
            path: parentGui ? getMenuPath(parentGui) : [],
            isFolder: true,
            controller: null,
            element: folder.$title,
            // The folder itself, so opening the chain opens the menu the user
            // was searching for rather than stopping at its parent.
            gui: folder,
            rootMenu: findRootMenu(folder),
        };
    }

    function collectMenuItems() {
        const items = [];
        const menuBar = Globals.menuBar;

        for (const slot of menuBar.slots) {
            if (!slot) continue;
            // Top-level menus are searchable too; their path is empty, so they
            // sort ahead of everything else.
            const item = folderItem(slot, null);
            if (item) items.push(item);
            collectFromGUI(slot, items);
        }
        return items;
    }

    function collectFromGUI(gui, items) {
        if (!gui || !gui.children) return;

        for (const child of gui.children) {
            if (child instanceof GUI) {
                // THE FOLDER ITSELF IS A RESULT. Previously the walk recursed
                // through folders collecting only their controls, so a menu
                // like "Masking" — the very thing a user types the word to
                // find — was the one item the search could never return.
                const item = folderItem(child, gui);
                if (item) items.push(item);
                collectFromGUI(child, items);
            } else if (child._name) {
                items.push({
                    name: child._name,
                    path: getMenuPath(gui),
                    isFolder: false,
                    controller: child,
                    element: child.domElement,
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
            highlightElement(match.element);
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
        highlightElement(match.element, 5000);

        // THE QUERY AND ITS RESULTS SURVIVE. Picking a result usually means
        // trying it and then coming back for the next one on the list; wiping
        // the box made that a retype every single time.
        selectedIndex = -1;
        hoverOpenedMenu = null;
    }

    function performSearch(query) {
        resultsContainer.innerHTML = '';
        resultsContainer.style.display = 'none';
        selectedIndex = -1;
        currentMatches = [];
        
        if (!query || query.length < 1) return;

        const items = collectMenuItems();
        const lowerQuery = query.toLowerCase();
        // Ranking, in the order the keys are applied:
        //   1. sub-menus before individual controls — someone typing "Masking"
        //      wants the Masking MENU, not a doc link that mentions masking;
        //   2. shallowest first, so a top-level menu beats one buried three
        //      levels down;
        //   3. a name that STARTS with the query before one that merely
        //      contains it, and an exact name before either;
        //   4. alphabetical, so equal-ranked results keep a stable order.
        currentMatches = items
            .map((item) => {
                const lowerName = item.name.toLowerCase();
                const at = lowerName.indexOf(lowerQuery);
                if (at < 0) return null;
                return {...item, _exact: lowerName === lowerQuery ? 0 : 1, _at: at};
            })
            .filter(Boolean)
            .sort((a, b) =>
                (a.isFolder === b.isFolder ? 0 : (a.isFolder ? -1 : 1))
                || (a.path.length - b.path.length)
                || (a._exact - b._exact)
                || (a._at - b._at)
                || a.name.localeCompare(b.name))
            .slice(0, 20);

        resultsContainer.style.display = currentMatches.length ? 'block' : 'none';

        for (const match of currentMatches) {
            const resultDiv = document.createElement('div');
            resultDiv.style.cssText = 'padding: 5px 8px; cursor: pointer; '
                + 'border-bottom: 1px solid #333; font-size: 11px; line-height: 1.35;';

            // Two tidy lines, each clipped with an ellipsis, instead of one
            // long string wrapping into its neighbour: the breadcrumb above,
            // the thing you are actually looking for below.
            if (match.path.length) {
                const pathLine = document.createElement('div');
                pathLine.textContent = match.path.join(' > ');
                pathLine.style.cssText = 'color: #888; white-space: nowrap; '
                    + 'overflow: hidden; text-overflow: ellipsis;';
                resultDiv.appendChild(pathLine);
            }
            const nameLine = document.createElement('div');
            nameLine.textContent = match.name;
            nameLine.style.cssText = `color: ${match.isFolder ? '#8ec7ff' : '#fff'}; `
                + 'white-space: nowrap; overflow: hidden; text-overflow: ellipsis;'
                + (match.isFolder ? ' font-weight: 600;' : '');
            resultDiv.appendChild(nameLine);

            // Only a tooltip that SAYS SOMETHING NEW. Most menu entries carry a
            // title equal to their own label, and a native tooltip repeating
            // the visible text was pure noise floating over the result list.
            const tooltip = match.element ? match.element.title : '';
            if (tooltip && tooltip.trim() !== match.name.trim()) {
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
            // Only the TRANSIENT state goes: the hover highlight and any menu
            // this search opened behind it. The query and its result list stay
            // so reopening Help resumes where the user left off.
            clearHighlight();
            helpMenu.lockOpenClose = false;
            if (hoverOpenedMenu && hoverOpenedMenu.mode === "DOCKED") {
                hoverOpenedMenu.close();
            }
            hoverOpenedMenu = null;
            selectedIndex = -1;
        }
    });
}
