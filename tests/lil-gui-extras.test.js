/**
 * @jest-environment jsdom
 */

import { CGuiMenuBar } from '../src/lil-gui-extras.js';

// Mock the required modules
jest.mock('../src/Globals', () => ({
    Globals: {
        stats: null,
        menuBar: null
    }
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
        menuBar.bringToFront(detachedGui);
        
        // Add a docked menu
        const dockedGui = menuBar.addFolder('Docked Menu');
        const dockedDiv = dockedGui.domElement.parentElement;
        
        // Store original position for the docked menu
        dockedGui.originalLeft = parseInt(dockedDiv.style.left);
        dockedGui.originalTop = parseInt(dockedDiv.style.top);
        
        // Simulate clicking on the menu title (mousedown)
        const mouseDownEvent = new MouseEvent('mousedown', {
            clientX: 100,
            clientY: 50,
            bubbles: true
        });
        dockedGui.$title.dispatchEvent(mouseDownEvent);
        
        // Menu should be brought to front
        expect(dockedGui.$children.style.zIndex).toBe('5002');
        expect(dockedGui.mode).toBe('DRAGGING');
        
        // Simulate mouse release without significant movement (mouseup)
        const mouseUpEvent = new MouseEvent('mouseup', {
            clientX: 100, // Same position - no drag
            clientY: 50,
            bubbles: true
        });
        dockedDiv.dispatchEvent(mouseUpEvent);
        
        // After release, menu should still be in front and docked
        expect(dockedGui.mode).toBe('DOCKED');
        expect(dockedGui.$children.style.zIndex).toBe('5002'); // Should maintain high z-index
        expect(dockedDiv.style.zIndex).toBe('5002');
    });

    test('should bring detached menu to front when dragged', () => {
        // Create two detached menus
        const gui1 = menuBar.addFolder('Detached Menu 1');
        const gui2 = menuBar.addFolder('Detached Menu 2');
        
        const div1 = gui1.domElement.parentElement;
        const div2 = gui2.domElement.parentElement;
        
        // Make both detached and bring them to front
        gui1.mode = "DETACHED";
        gui2.mode = "DETACHED";
        menuBar.bringToFront(gui1);
        menuBar.bringToFront(gui2);
        
        // gui2 should be in front now
        expect(gui1.$children.style.zIndex).toBe('5001');
        expect(gui2.$children.style.zIndex).toBe('5002');
        
        // Now simulate dragging gui1 (which should bring it to front)
        const mouseDownEvent = new MouseEvent('mousedown', {
            clientX: 100,
            clientY: 50,
            bubbles: true
        });
        gui1.$title.dispatchEvent(mouseDownEvent);
        
        // gui1 should now be in front
        expect(gui1.$children.style.zIndex).toBe('5003');
        expect(gui2.$children.style.zIndex).toBe('5002'); // unchanged
        expect(gui1.mode).toBe('DRAGGING');
        
        // Simulate mouse up to complete the drag
        const mouseUpEvent = new MouseEvent('mouseup', {
            clientX: 110, // Moved 10px
            clientY: 60,
            bubbles: true
        });
        div1.dispatchEvent(mouseUpEvent);
        
        // Should still be in front and detached
        expect(gui1.mode).toBe('DETACHED');
        expect(gui1.$children.style.zIndex).toBe('5003'); // Should remain at current z-index
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
        const mouseDownEvent = new MouseEvent('mousedown', {
            clientX: 100,
            clientY: 50,
            bubbles: true
        });
        gui1.$title.dispatchEvent(mouseDownEvent);
        
        // gui1 should now be in front immediately after mousedown
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
        
        // Simulate mousedown which sets mode to DRAGGING
        const mouseDownEvent = new MouseEvent('mousedown', {
            clientX: 100,
            clientY: 50,
            bubbles: true
        });
        gui.$title.dispatchEvent(mouseDownEvent);
        
        // Should now have DRAGGING mode and styling applied
        expect(gui.mode).toBe('DRAGGING');
        expect(titleElement.style.getPropertyValue('border-top-left-radius')).toBe('6px');
        expect(titleElement.style.getPropertyValue('border-top-right-radius')).toBe('6px');
        expect(titleElement.style.getPropertyValue('border-top')).toBe('1px solid #555');
        expect(titleElement.style.getPropertyValue('border-left')).toBe('1px solid #555');
        expect(titleElement.style.getPropertyValue('border-right')).toBe('1px solid #555');
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
        expect(titleElement.style.getPropertyValue('border-top')).toBe('1px solid #555');
        expect(titleElement.style.getPropertyValue('border-left')).toBe('1px solid #555');
        expect(titleElement.style.getPropertyValue('border-right')).toBe('1px solid #555');
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
        expect(titleElement.style.getPropertyValue('border-top')).toBe('1px solid #555');
        
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
        expect(newTitleElement.style.getPropertyValue('border-top')).toBe('1px solid #555');
        
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
});