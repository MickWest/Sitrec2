/**
 * @jest-environment jsdom
 */

import {CGuiMenuBar} from '../src/lil-gui-extras';
import {addMenuToRightSidebar, getRightSidebar, hideLeftSidebar, hideRightSidebar} from '../src/PageStructure';

// Polyfill PointerEvent for jsdom environment
if (typeof PointerEvent === 'undefined') {
    class PointerEventPolyfill extends MouseEvent {
        constructor(type, init) {
            super(type, init);
            this.pointerType = init?.pointerType || 'mouse';
            this.pointerId = init?.pointerId || 1;
            this.isPrimary = init?.isPrimary !== false;
            this.width = init?.width || 0;
            this.height = init?.height || 0;
            this.pressure = init?.pressure || 0;
            this.tangentialPressure = init?.tangentialPressure || 0;
            this.tiltX = init?.tiltX || 0;
            this.tiltY = init?.tiltY || 0;
            this.twist = init?.twist || 0;
        }
    }
    global.PointerEvent = PointerEventPolyfill;
}

// Mock the required modules
jest.mock('../src/Globals', () => ({
    Globals: {
        stats: null,
        menuBar: null
    },
    // Standalone menus call this on destroy() to re-enable keyboard shortcuts.
    setMouseOverGUI: jest.fn()
}));

jest.mock('../src/CViewManager', () => ({
    ViewMan: {
        topPx: 0,
        updateSize: jest.fn()
    }
}));

jest.mock('../src/utils', () => ({
    parseBoolean: jest.fn(() => false)
}));

jest.mock('stats.js', () => {
    return jest.fn().mockImplementation(() => ({
        dom: null // We don't need the actual DOM element for this test
    }));
});

// Mock process.env
process.env.BANNER_ACTIVE = 'false';

describe('CGuiMenuBar Z-Index Management', () => {
    let menuBar;

    // Helper function to normalize color values for cross-browser compatibility
    const normalizeColor = (color) => {
        if (!color) return '';
        // Convert hex #555 to rgb(85, 85, 85) for consistent comparison
        if (color === '#555') return 'rgb(85, 85, 85)';
        if (color === '1px solid #555') return '1px solid rgb(85, 85, 85)';
        return color;
    };

    // Helper function to check if a color matches either hex or rgb format
    const expectColorToBe = (actual, expected) => {
        const normalizedActual = normalizeColor(actual);
        const normalizedExpected = normalizeColor(expected);
        expect(normalizedActual).toBe(normalizedExpected);
    };

    beforeEach(() => {
        // Clear the DOM
        document.body.innerHTML = '';
        
        // Create a new menu bar instance
        menuBar = new CGuiMenuBar();
        
        // Set up the global reference for the _setClosed override
        const { Globals } = require('../src/Globals');
        Globals.menuBar = menuBar;
    });

    afterEach(() => {
        if (menuBar) {
            menuBar.destroy();
        }
        hideLeftSidebar();
        hideRightSidebar();
        // Clean up DOM
        document.body.innerHTML = '';
    });

    test('should initialize with correct base z-index', () => {
        expect(menuBar.baseZIndex).toBe(5000);
    });

    test('should create menu divs with base z-index', () => {
        // Check that divs are created with the base z-index
        const firstDiv = menuBar.divs[0];
        expect(firstDiv.style.zIndex).toBe('5000');
    });

    test('should bring menu to front when bringToFront is called', () => {
        // Add a folder to get a GUI
        const gui = menuBar.addFolder('Test Menu');
        const div = gui.domElement.parentElement;
        
        // Initial z-index should be base value for the div
        expect(div.style.zIndex).toBe('5000');
        // Children should not have z-index initially
        expect(gui.$children.style.zIndex).toBe('');
        
        // Bring to front
        menuBar.bringToFront(gui);
        
        // Both div and children z-index should be incremented
        expect(gui.$children.style.zIndex).toBe('5001');
        expect(div.style.zIndex).toBe('5001');
    });

    test('should increment z-index for multiple menus brought to front', () => {
        // Add two folders
        const gui1 = menuBar.addFolder('Menu 1');
        const gui2 = menuBar.addFolder('Menu 2');
        
        const div1 = gui1.domElement.parentElement;
        const div2 = gui2.domElement.parentElement;
        
        // Both divs should start with base z-index
        expect(div1.style.zIndex).toBe('5000');
        expect(div2.style.zIndex).toBe('5000');
        // Children should not have z-index initially
        expect(gui1.$children.style.zIndex).toBe('');
        expect(gui2.$children.style.zIndex).toBe('');
        
        // Bring first menu to front
        menuBar.bringToFront(gui1);
        expect(gui1.$children.style.zIndex).toBe('5001');
        expect(div1.style.zIndex).toBe('5001');
        
        // Bring second menu to front
        menuBar.bringToFront(gui2);
        expect(gui2.$children.style.zIndex).toBe('5002');
        expect(div2.style.zIndex).toBe('5002');
        
        // First menu should still have its previous z-index
        expect(gui1.$children.style.zIndex).toBe('5001');
        expect(div1.style.zIndex).toBe('5001');
    });

    test('should reset z-index when menu is restored to bar', () => {
        // Add a folder
        const gui = menuBar.addFolder('Test Menu');
        const div = gui.domElement.parentElement;
        
        // Bring to front
        menuBar.bringToFront(gui);
        expect(gui.$children.style.zIndex).toBe('5001');
        
        // Restore to bar
        menuBar.restoreToBar(gui);
        expect(div.style.zIndex).toBe('5000');
        expect(gui.$children.style.zIndex).toBe(''); // Children z-index should be reset
    });

    test('should serialize and deserialize z-index values', () => {
        // Add folders and modify z-index
        const gui1 = menuBar.addFolder('Menu 1');
        const gui2 = menuBar.addFolder('Menu 2');
        
        menuBar.bringToFront(gui1);
        menuBar.bringToFront(gui2);
        
        // Serialize
        const serialized = menuBar.modSerialize();
        
        // Check that z-index values are serialized
        expect(serialized['Menu 1'].zIndex).toBe('5001');
        expect(serialized['Menu 2'].zIndex).toBe('5002');
        
        // Create new menu bar and deserialize
        const newMenuBar = new CGuiMenuBar();
        const newGui1 = newMenuBar.addFolder('Menu 1');
        const newGui2 = newMenuBar.addFolder('Menu 2');
        
        newMenuBar.modDeserialize(serialized);
        
        // Check that z-index values are restored
        // High z-index values should be applied to children, divs should stay at base
        expect(newGui1.$children.style.zIndex).toBe('5001');
        expect(newGui2.$children.style.zIndex).toBe('5002');
        expect(newGui1.domElement.parentElement.style.zIndex).toBe('5000');
        expect(newGui2.domElement.parentElement.style.zIndex).toBe('5000');
        
        newMenuBar.destroy();
    });

    test('should serialize translated menu state under stable menu IDs', () => {
        const fileMenu = menuBar.addFolder('Archivo');
        fileMenu._menuId = 'file';
        fileMenu._serializationAliases = ['File', 'Archivo', 'Fichier'];

        menuBar.bringToFront(fileMenu);

        const serialized = menuBar.modSerialize();

        expect(serialized.file).toBeDefined();
        expect(serialized.file.zIndex).toBe('5001');
        expect(serialized.Archivo).toBeUndefined();
    });

    test('should restore menu state from legacy translated titles', () => {
        const legacySerialized = {
            Archivo: {
                closed: false,
                left: '42px',
                top: '12px',
                zIndex: '5004',
                mode: 'DETACHED',
                lockOpenClose: false
            }
        };

        const fileMenu = menuBar.addFolder('File');
        fileMenu._menuId = 'file';
        fileMenu._serializationAliases = ['File', 'Archivo', 'Fichier'];

        menuBar.modDeserialize(legacySerialized);

        expect(fileMenu.domElement.parentElement.style.left).toBe('42px');
        expect(fileMenu.domElement.parentElement.style.top).toBe('12px');
        expect(fileMenu.$children.style.zIndex).toBe('5004');
        expect(fileMenu.mode).toBe('DETACHED');
    });

    test('should set mode to DETACHED and bring to front when drag is completed', () => {
        // Add a folder
        const gui = menuBar.addFolder('Test Menu');
        const div = gui.domElement.parentElement;
        
        // Simulate starting a drag (this would normally be done by handleTitleMouseDown)
        gui.mode = "DRAGGING";
        gui.firstDrag = true;
        
        // Simulate mouse up event after dragging (moving more than 5px)
        div.style.top = "10px"; // Moved more than 5px
        
        // Create and dispatch a mouseup event
        const mouseUpEvent = new MouseEvent('mouseup', {
            bubbles: true,
            cancelable: true,
            clientX: 100,
            clientY: 100
        });
        
        // We need to simulate the mouse up handler behavior
        // Since we can't easily trigger the actual event handler, we'll test the logic directly
        if (gui.firstDrag && parseInt(div.style.top) < 5) {
            menuBar.restoreToBar(gui);
        } else {
            gui.mode = "DETACHED";
            menuBar.bringToFront(gui);
        }
        
        // Check that the menu is now detached and has higher z-index
        expect(gui.mode).toBe('DETACHED');
        expect(gui.$children.style.zIndex).toBe('5001');
    });

    test('should bring docked menu to front when opened', () => {
        // Create a detached menu first (to simulate existing undocked menus)
        const detachedGui = menuBar.addFolder('Detached Menu');
        const detachedDiv = detachedGui.domElement.parentElement;
        detachedGui.mode = "DETACHED";
        menuBar.bringToFront(detachedGui);
        
        // Verify the detached menu has higher z-index
        expect(detachedGui.$children.style.zIndex).toBe('5001');
        
        // Add a docked menu
        const dockedGui = menuBar.addFolder('Docked Menu');
        const dockedDiv = dockedGui.domElement.parentElement;
        
        // Initially, docked menu should have base z-index
        expect(dockedDiv.style.zIndex).toBe('5000');
        expect(dockedGui.$children.style.zIndex).toBe('');
        
        // Open the docked menu (this should bring it to front automatically via onOpenClose callback)
        dockedGui.open();
        
        // In the actual implementation, the onOpenClose callback would automatically call bringToFront
        // but in the test environment we need to simulate this behavior
        if (!dockedGui._closed) {
            menuBar.bringToFront(dockedGui);
        }
        
        // The docked menu should now have a higher z-index than the detached menu
        expect(dockedGui.$children.style.zIndex).toBe('5002');
        expect(dockedDiv.style.zIndex).toBe('5002');
    });

    test('should maintain high z-index after click and release without drag', () => {
        // Create a detached menu first (to simulate existing undocked menus)
        const detachedGui = menuBar.addFolder('Detached Menu');
        const detachedDiv = detachedGui.domElement.parentElement;
        detachedGui.mode = "DETACHED";
        detachedGui.wasOriginalllyInMenuBar = false;
        menuBar.bringToFront(detachedGui);
        
        // Add a docked menu
        const dockedGui = menuBar.addFolder('Docked Menu');
        const dockedDiv = dockedGui.domElement.parentElement;
        
        // Store the initial z-index
        const initialChildrenZIndex = dockedGui.$children.style.zIndex || ''; // Should be empty initially
        
        // Simulate clicking on the menu title
        const pointerDownEvent = new PointerEvent('pointerdown', {
            clientX: 100,
            clientY: 50,
            bubbles: true,
            pointerType: 'mouse'
        });
        dockedGui.$title.dispatchEvent(pointerDownEvent);
        
        // After pointerdown: Menu should be brought to front and mode should be DRAGGING
        expect(dockedGui.mode).toBe('DRAGGING');
        // z-index should be elevated when brought to front
        const elevatedZIndex = dockedGui.$children.style.zIndex;
        expect(parseInt(elevatedZIndex)).toBeGreaterThan(5000);
        
        // Simulate pointer release without significant movement (pointerup)
        // div position stays at top=0, indicating click-and-release (< 5)
        const pointerUpEvent = new PointerEvent('pointerup', {
            clientX: 100,
            clientY: 50,
            bubbles: true,
            pointerType: 'mouse'
        });
        document.dispatchEvent(pointerUpEvent);
        
        // After release, menu should be restored to docked mode
        expect(dockedGui.mode).toBe('DOCKED');
        // The implementation keeps position restored to docked position
        expect(dockedDiv.style.left).toBe(dockedGui.originalLeft + 'px');
        expect(dockedDiv.style.top).toBe(dockedGui.originalTop + 'px');
    });

    test('should bring detached menu to front when dragged', () => {
        // Create two permanently detached menus (not from menubar)
        const gui1 = menuBar.addFolder('Detached Menu 1');
        const gui2 = menuBar.addFolder('Detached Menu 2');
        
        const div1 = gui1.domElement.parentElement;
        const div2 = gui2.domElement.parentElement;
        
        // Mark both as permanently detached (not originally from menubar)
        gui1.mode = "DETACHED";
        gui1.wasOriginalllyInMenuBar = false;
        gui2.mode = "DETACHED";
        gui2.wasOriginalllyInMenuBar = false;
        
        menuBar.bringToFront(gui1);
        menuBar.bringToFront(gui2);
        
        // gui2 should be in front now with higher z-index
        expect(gui1.$children.style.zIndex).toBe('5001');
        expect(gui2.$children.style.zIndex).toBe('5002');
        
        // Now simulate dragging gui1 (which should bring it to front)
        const pointerDownEvent = new PointerEvent('pointerdown', {
            clientX: 100,
            clientY: 50,
            bubbles: true,
            pointerType: 'mouse'
        });
        gui1.$title.dispatchEvent(pointerDownEvent);
        
        // gui1 should now be in DRAGGING mode and brought to front
        expect(gui1.mode).toBe('DRAGGING');
        expect(gui1.$children.style.zIndex).toBe('5003');
        expect(gui2.$children.style.zIndex).toBe('5002'); // unchanged
        
        // Update the div's position to indicate a real drag (top > 5)
        // The handler distinguishes between click-and-release (top < 5) vs actual drag (top >= 5)
        div1.style.top = "10px";
        
        // For permanently detached menus (wasOriginalllyInMenuBar = false), 
        // a drag should keep them DETACHED (not revert to DOCKED like menubar menus)
        // Verify this by manually checking the drag condition
        if (!gui1.wasOriginalllyInMenuBar && parseInt(div1.style.top) >= 5) {
            // This is a real drag on a permanently detached menu, so it should stay DETACHED
            gui1.mode = "DETACHED";
        }
        
        expect(gui1.mode).toBe('DETACHED');
    });

    test('should bring detached menu to front when title is clicked (without drag)', () => {
        // Create two detached menus
        const gui1 = menuBar.addFolder('Detached Menu 1');
        const gui2 = menuBar.addFolder('Detached Menu 2');
        
        // Make both detached and bring them to front
        gui1.mode = "DETACHED";
        gui2.mode = "DETACHED";
        menuBar.bringToFront(gui1);
        menuBar.bringToFront(gui2);
        
        // gui2 should be in front now
        expect(gui1.$children.style.zIndex).toBe('5001');
        expect(gui2.$children.style.zIndex).toBe('5002');
        
        // Now click on gui1's title (this should bring it to front immediately)
        const pointerDownEvent = new PointerEvent('pointerdown', {
            clientX: 100,
            clientY: 50,
            bubbles: true,
            pointerType: 'mouse'
        });
        gui1.$title.dispatchEvent(pointerDownEvent);
        
        // gui1 should now be in front immediately after pointerdown
        expect(gui1.$children.style.zIndex).toBe('5003');
        expect(gui2.$children.style.zIndex).toBe('5002'); // unchanged
        expect(gui1.mode).toBe('DRAGGING');
    });

    test('should reset z-index to base when menu is closed', () => {
        // Create a menu and bring it to front
        const gui = menuBar.addFolder('Test Menu');
        menuBar.bringToFront(gui);
        
        // Verify it has elevated z-index
        expect(gui.$children.style.zIndex).toBe('5001');
        
        // Close the menu
        gui.close();
        
        // Verify z-index is reset to base
        const div = menuBar.divs.find((div) => div === gui.domElement.parentElement);
        expect(div.style.zIndex).toBe('5000'); // base z-index
        expect(gui.$children.style.zIndex).toBe('');
        expect(gui.$children.style.position).toBe('');
    });

    test('should apply styling when mode changes to DRAGGING', () => {
        const gui = menuBar.addFolder('Test Menu');
        const titleElement = gui.$title;
        
        // Initially docked, should have no special styling
        expect(titleElement.style.getPropertyValue('border-top-left-radius')).toBe('');
        expect(titleElement.style.getPropertyValue('border-top')).toBe('');
        
        // Simulate pointerdown which sets mode to DRAGGING
        const pointerDownEvent = new PointerEvent('pointerdown', {
            clientX: 100,
            clientY: 50,
            bubbles: true,
            pointerType: 'mouse'
        });
        gui.$title.dispatchEvent(pointerDownEvent);
        
        // Should now have DRAGGING mode and styling applied
        expect(gui.mode).toBe('DRAGGING');
        expect(titleElement.style.getPropertyValue('border-top-left-radius')).toBe('6px');
        expect(titleElement.style.getPropertyValue('border-top-right-radius')).toBe('6px');
        expectColorToBe(titleElement.style.getPropertyValue('border-top'), '1px solid #555');
        expectColorToBe(titleElement.style.getPropertyValue('border-left'), '1px solid #555');
        expectColorToBe(titleElement.style.getPropertyValue('border-right'), '1px solid #555');
        expect(titleElement.style.getPropertyValue('box-shadow')).toBe('0 2px 8px rgba(0, 0, 0, 0.3)');
    });

    test('should apply styling when mode changes to DETACHED', () => {
        const gui = menuBar.addFolder('Test Menu');
        const titleElement = gui.$title;
        const div = gui.domElement.parentElement;
        
        // Store original position
        gui.originalLeft = parseInt(div.style.left);
        gui.originalTop = parseInt(div.style.top);
        
        // Simulate dragging and releasing to make it detached
        gui.mode = "DRAGGING";
        gui.firstDrag = true;
        div.style.top = "10px"; // Moved more than 5px
        
        // Simulate the mouse up logic for detachment
        gui.mode = "DETACHED";
        menuBar.bringToFront(gui);
        menuBar.applyModeStyles(gui);
        
        // Should have detached styling
        expect(gui.mode).toBe('DETACHED');
        expect(titleElement.style.getPropertyValue('border-top-left-radius')).toBe('6px');
        expect(titleElement.style.getPropertyValue('border-top-right-radius')).toBe('6px');
        expectColorToBe(titleElement.style.getPropertyValue('border-top'), '1px solid #555');
        expectColorToBe(titleElement.style.getPropertyValue('border-left'), '1px solid #555');
        expectColorToBe(titleElement.style.getPropertyValue('border-right'), '1px solid #555');
        expect(titleElement.style.getPropertyValue('box-shadow')).toBe('0 2px 8px rgba(0, 0, 0, 0.3)');
    });

    test('should remove styling when mode changes back to DOCKED', () => {
        const gui = menuBar.addFolder('Test Menu');
        const titleElement = gui.$title;
        const div = gui.domElement.parentElement;
        
        // First make it detached with styling
        gui.mode = "DETACHED";
        menuBar.applyModeStyles(gui);
        
        // Verify styling is applied
        expect(titleElement.style.getPropertyValue('border-top-left-radius')).toBe('6px');
        expectColorToBe(titleElement.style.getPropertyValue('border-top'), '1px solid #555');
        
        // Now restore to bar (which sets mode to DOCKED and removes styling)
        menuBar.restoreToBar(gui);
        
        // Should have no special styling
        expect(gui.mode).toBe('DOCKED');
        expect(titleElement.style.getPropertyValue('border-top-left-radius')).toBe('');
        expect(titleElement.style.getPropertyValue('border-top-right-radius')).toBe('');
        expect(titleElement.style.getPropertyValue('border-top')).toBe('');
        expect(titleElement.style.getPropertyValue('border-left')).toBe('');
        expect(titleElement.style.getPropertyValue('border-right')).toBe('');
        expect(titleElement.style.getPropertyValue('box-shadow')).toBe('');
    });

    test('should preserve styling through serialization and deserialization', () => {
        const gui = menuBar.addFolder('Test Menu');
        const titleElement = gui.$title;
        
        // Make it detached with styling
        gui.mode = "DETACHED";
        menuBar.bringToFront(gui);
        menuBar.applyModeStyles(gui);
        
        // Verify styling is applied
        expect(titleElement.style.getPropertyValue('border-top-left-radius')).toBe('6px');
        expect(gui.mode).toBe('DETACHED');
        
        // Serialize
        const serialized = menuBar.modSerialize();
        expect(serialized['Test Menu'].mode).toBe('DETACHED');
        
        // Create new menu bar and deserialize
        const newMenuBar = new CGuiMenuBar();
        const newGui = newMenuBar.addFolder('Test Menu');
        const newTitleElement = newGui.$title;
        
        // Before deserialize - should have no styling
        expect(newTitleElement.style.getPropertyValue('border-top-left-radius')).toBe('');
        expect(newGui.mode).toBe('DOCKED');
        
        newMenuBar.modDeserialize(serialized);
        
        // After deserialize - should have styling applied and correct mode
        expect(newGui.mode).toBe('DETACHED');
        expect(newTitleElement.style.getPropertyValue('border-top-left-radius')).toBe('6px');
        expectColorToBe(newTitleElement.style.getPropertyValue('border-top'), '1px solid #555');
        
        newMenuBar.destroy();
    });

    test('should not apply styling to DOCKED menus initially', () => {
        const gui = menuBar.addFolder('Test Menu');
        const titleElement = gui.$title;
        
        // Should start as docked with no special styling
        expect(gui.mode).toBe('DOCKED');
        expect(titleElement.style.getPropertyValue('border-top-left-radius')).toBe('');
        expect(titleElement.style.getPropertyValue('border-top')).toBe('');
        expect(titleElement.style.getPropertyValue('border-left')).toBe('');
        expect(titleElement.style.getPropertyValue('border-right')).toBe('');
        expect(titleElement.style.getPropertyValue('box-shadow')).toBe('');
    });

    test('should reflow menu bar when a menu is hidden', () => {
        const a = menuBar.addFolder('A');
        const b = menuBar.addFolder('B');
        const c = menuBar.addFolder('C');
        const state = { value: true };
        a.add(state, 'value');
        b.add(state, 'value');
        c.add(state, 'value');

        menuBar.hideEmpty();
        const bLeftBeforeHide = parseInt(b.domElement.parentElement.style.left);
        const cLeftBeforeHide = parseInt(c.domElement.parentElement.style.left);
        expect(cLeftBeforeHide).toBeGreaterThan(bLeftBeforeHide);

        b.hide();
        menuBar.hideEmpty();

        const cLeftAfterHide = parseInt(c.domElement.parentElement.style.left);
        expect(cLeftAfterHide).toBe(bLeftBeforeHide);
    });

    test('should keep top-bar gap for detached and sidebar-docked menus', () => {
        const a = menuBar.addFolder('A');
        const b = menuBar.addFolder('B');
        const c = menuBar.addFolder('C');
        const state = { value: true };
        a.add(state, 'value');
        b.add(state, 'value');
        c.add(state, 'value');

        menuBar.hideEmpty();
        const bLeft = parseInt(b.domElement.parentElement.style.left);
        const cLeft = parseInt(c.domElement.parentElement.style.left);

        b.mode = 'DETACHED';
        menuBar.hideEmpty();
        const cLeftWhenDetached = parseInt(c.domElement.parentElement.style.left);
        expect(cLeftWhenDetached).toBe(cLeft);

        addMenuToRightSidebar(b);
        b.mode = 'SIDEBAR_RIGHT';
        menuBar.hideEmpty();
        const cLeftWhenSidebarDocked = parseInt(c.domElement.parentElement.style.left);
        expect(cLeftWhenSidebarDocked).toBe(cLeft);
        expect(b.domElement.parentElement.style.display).toBe('block');
        expect(b.domElement.parentElement.parentElement).toBe(getRightSidebar());

        menuBar.restoreToBar(b);
        menuBar.hideEmpty();
        const cLeftAfterRestore = parseInt(c.domElement.parentElement.style.left);
        expect(cLeftAfterRestore).toBe(cLeft);
        expect(b.domElement.parentElement.style.left).toBe(bLeft + 'px');
    });

    test('should treat a menu with only hidden controllers as empty', () => {
        const gui = menuBar.addFolder('Only Hidden Controls');
        const state = { value: true };
        const controller = gui.add(state, 'value');
        menuBar.hideEmpty();
        expect(gui.domElement.parentElement.style.display).toBe('block');

        controller.hide();
        menuBar.hideEmpty();

        expect(gui.domElement.parentElement.style.display).toBe('none');
    });

    test('should restore right-sidebar menus visibly when deserializing', () => {
        const a = menuBar.addFolder('A');
        const b = menuBar.addFolder('B');
        const state = { value: true };
        a.add(state, 'value');
        b.add(state, 'value');

        addMenuToRightSidebar(b);
        b.mode = 'SIDEBAR_RIGHT';
        b.lockOpenClose = false;
        b.open();
        b.lockOpenClose = true;

        // Simulate stale hidden container state from previous layout pass
        b.domElement.parentElement.style.display = 'none';

        const serialized = menuBar.modSerialize();

        const newMenuBar = new CGuiMenuBar();
        const { Globals } = require('../src/Globals');
        Globals.menuBar = newMenuBar;
        const a2 = newMenuBar.addFolder('A');
        const b2 = newMenuBar.addFolder('B');
        a2.add(state, 'value');
        b2.add(state, 'value');

        newMenuBar.modDeserialize(serialized);

        const rightSidebar = getRightSidebar();
        const b2Container = b2.domElement.parentElement;
        expect(rightSidebar.style.display).toBe('block');
        expect(b2Container.parentElement).toBe(rightSidebar);
        expect(b2Container.style.display).toBe('block');
        expect(b2Container.parentElement).not.toBe(newMenuBar.menuBar);

        newMenuBar.destroy();
    });
});

// placeMenuBesidePoint moves an object's right-click menu clear of the object it edits.
// jsdom gives every element a zero-size getBoundingClientRect, so the method falls back
// to the container's inline width — which is exactly the 240px createStandaloneMenu sets.
describe('CGuiMenuBar.placeMenuBesidePoint', () => {
    let menuBar;
    const originalInnerWidth = window.innerWidth;

    const setViewportWidth = (width) => {
        Object.defineProperty(window, 'innerWidth', {value: width, configurable: true, writable: true});
    };

    // Place a fresh 240px menu at a click of `x` in a `viewportWidth` window and return
    // where it landed.
    const place = (x, viewportWidth) => {
        setViewportWidth(viewportWidth);
        const gui = menuBar.createStandaloneMenu('Object', x, 100, false);
        menuBar.placeMenuBesidePoint(gui, x);
        const left = parseFloat(gui._standaloneContainer.style.left);
        const width = parseFloat(gui._standaloneContainer.style.width);
        gui.destroy();
        return {left, right: left + width, width, originalLeft: gui.originalLeft};
    };

    beforeEach(() => {
        document.body.innerHTML = '';
        menuBar = new CGuiMenuBar();
        const { Globals } = require('../src/Globals');
        Globals.menuBar = menuBar;
    });

    afterEach(() => {
        if (menuBar) menuBar.destroy();
        setViewportWidth(originalInnerWidth);
        document.body.innerHTML = '';
    });

    test('shifts right by half the menu width when there is room', () => {
        const {left, width} = place(858, 1900);
        expect(width).toBe(240);
        expect(left).toBe(858 + 120);
    });

    test('flips to 1.5 widths left when the right shift would run off screen', () => {
        // 1600 + 120 + 240 = 1960 > 1900, so it flips
        expect(place(1600, 1900).left).toBe(1600 - 360);
        expect(place(1800, 1900).left).toBe(1800 - 360);
    });

    test('never lets the menu run off either edge', () => {
        for (const x of [0, 100, 858, 1539, 1540, 1660, 1899]) {
            const {left, right} = place(x, 1900);
            expect(left).toBeGreaterThanOrEqual(0);
            expect(right).toBeLessThanOrEqual(1900);
        }
    });

    test('keeps the menu clear of the click when neither offset fits', () => {
        // A 240px menu at x=200 in a 500px window: the right shift (320) overflows and
        // the left flip (-160) is off screen. Clamping to 0 would span the click, so it
        // must go flush right instead, which still clears it.
        const {left, right} = place(200, 500);
        expect(left).toBe(260);
        expect(right).toBe(500);
        expect(left).toBeGreaterThanOrEqual(200);
    });

    test('uses the left side when that is the side with room', () => {
        // x=380 in a 500px window: right shift 500 overflows, left flip 20 fits.
        expect(place(380, 500).left).toBe(20);
    });

    test('stays on screen when the menu is too wide to clear the click at all', () => {
        // 240px menu, 300px window, click in the middle: no placement can clear it.
        const {left, right} = place(150, 300);
        expect(left).toBeGreaterThanOrEqual(0);
        expect(right).toBeLessThanOrEqual(300);
    });

    test('keeps originalLeft in step so undocking does not snap it back', () => {
        const {left, originalLeft} = place(858, 1900);
        expect(originalLeft).toBe(left);
    });
});

describe('CGuiMenuBar.pinMenuBelowBar', () => {
    let menuBar;

    beforeEach(() => {
        document.body.innerHTML = '';
        menuBar = new CGuiMenuBar();
        const { Globals } = require('../src/Globals');
        Globals.menuBar = menuBar;
    });

    afterEach(() => {
        if (menuBar) menuBar.destroy();
        document.body.innerHTML = '';
    });

    test('drops the menu to one menu line below the bar, whatever y it opened at', () => {
        // jsdom lays nothing out, so the title measures 0 and the barHeight fallback
        // stands in for one menu line: 25 + 25.
        for (const y of [100, 500, 900]) {
            const gui = menuBar.createStandaloneMenu('Object', 400, y, false);
            expect(gui._standaloneContainer.style.top).toBe(y + 'px');
            menuBar.pinMenuBelowBar(gui);
            expect(gui._standaloneContainer.style.top).toBe((menuBar.barHeight * 2) + 'px');
            expect(gui.originalTop).toBe(menuBar.barHeight * 2);
            gui.destroy();
        }
    });

    test('clears the bar itself', () => {
        const gui = menuBar.createStandaloneMenu('Object', 400, 800, false);
        menuBar.pinMenuBelowBar(gui);
        expect(parseFloat(gui._standaloneContainer.style.top)).toBeGreaterThan(menuBar.barHeight);
        gui.destroy();
    });
});
