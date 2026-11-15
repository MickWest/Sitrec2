/**
 * @jest-environment jsdom
 */

// The views must start at the bottom edge of the menu bar, which is the bar plus the line
// under it. They started 2 px above that edge (24 against 26), so the bar painted over the top
// two rows of each view at the top of the window. A video at 100% zoom fills its view exactly,
// and so it lost its top edge.

import {ViewMan} from '../src/CViewManager';
import {CGuiMenuBar} from '../src/lil-gui-extras';
import {MENU_BAR_BORDER, MENU_BAR_BOTTOM, MENU_BAR_HEIGHT} from '../src/PageStructure';

jest.mock('../src/Globals', () => ({
    Globals: {stats: null, menuBar: null},
    setMouseOverGUI: jest.fn(),
    setRenderOne: jest.fn(),
}));

jest.mock('../src/utils', () => ({
    parseBoolean: jest.fn(() => false),
}));

jest.mock('stats.js', () => jest.fn().mockImplementation(() => ({dom: null})));

process.env.BANNER_ACTIVE = 'false';

// jsdom does no layout, so the bar's bottom edge is read from the styles that give it its size.
// The bar is a content-box: its height does not include the border.
const barBottomPx = (bar) => parseFloat(bar.style.top)
    + parseFloat(bar.style.height)
    + parseFloat(bar.style.borderBottomWidth);

describe('The views start at the bottom edge of the menu bar', () => {
    // Read before a menu bar exists: this is the value from the ViewMan constructor, and the
    // one in force for a whole session unless the bar is hidden and shown again.
    const topAtStartup = ViewMan.topPx;
    let menuBar;

    // jsdom has no fullscreenElement at all, and the bar reads "not null" as full-screen.
    const setFullScreen = (on) => Object.defineProperty(document, 'fullscreenElement',
        {configurable: true, value: on ? document.body : null});

    beforeEach(() => {
        setFullScreen(false);
        menuBar = new CGuiMenuBar();
        const {Globals} = require('../src/Globals');
        Globals.menuBar = menuBar;
    });

    afterEach(() => {
        menuBar.destroy();
    });

    test('the bottom edge is the bar height plus the line under it', () => {
        expect(MENU_BAR_BOTTOM).toBe(MENU_BAR_HEIGHT + MENU_BAR_BORDER);
        expect(menuBar.bar.style.boxSizing).not.toBe('border-box');
        expect(barBottomPx(menuBar.bar)).toBe(MENU_BAR_BOTTOM);
    });

    test('at startup', () => {
        expect(topAtStartup).toBe(barBottomPx(menuBar.bar));
    });

    test('after the menu bar is hidden and shown again', () => {
        menuBar.hide();
        expect(ViewMan.topPx).toBe(0);      // no bar, so the views take the whole height
        menuBar.show();
        expect(ViewMan.topPx).toBe(barBottomPx(menuBar.bar));
    });

    test('in browser full-screen mode, where the bar moves down', () => {
        setFullScreen(true);
        menuBar.show();
        expect(parseFloat(menuBar.bar.style.top)).toBeGreaterThan(0);
        expect(ViewMan.topPx).toBe(barBottomPx(menuBar.bar));
    });

    test('the view area is the container height below that edge', () => {
        menuBar.show();
        Object.defineProperty(ViewMan.container, 'offsetHeight', {configurable: true, value: 966});
        ViewMan.updateSize();
        expect(ViewMan.heightPx).toBe(966 - barBottomPx(menuBar.bar));
        expect(ViewMan.heightPx).toBe(966 - MENU_BAR_BOTTOM);
    });
});
