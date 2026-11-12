/** @jest-environment jsdom */
// A side rail holds menus, native widgets and docked views. Menus and widgets register
// with the rail. A docked view does not: CNodeView appends its div directly. The rail
// must stay open for every occupant that shows, and close when only hidden widgets remain.

if (!window.matchMedia) {
    window.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}});
}

const {CNodeView} = require("../src/nodes/CNodeView");
const {WidgetPanel} = require("../src/WidgetPanel");
const {getLeftSidebar, getRightSidebar, hideLeftSidebar, hideRightSidebar} = require("../src/PageStructure");

// Loading the view class also runs the page setup, which makes the Content element.
const content = document.getElementById("Content")
    ?? document.body.appendChild(Object.assign(document.createElement("div"), {id: "Content"}));
let home, panel, viewDivs;

// The parts of a view that docking uses, with the real docking methods.
function dockableView() {
    const div = document.createElement("div");
    document.body.append(div);
    viewDivs.push(div);
    return {
        div, dockable: true, dockedSidebar: null, visible: true,
        saveFloatingRect() {}, currentAspectRatio: () => 1, setResizeHandlesVisible() {}, updateDockedWH() {},
        getDockSidebar: CNodeView.prototype.getDockSidebar,
        hideSidebarIfEmpty: CNodeView.prototype.hideSidebarIfEmpty,
        dock(side) { CNodeView.prototype.dockToSidebar.call(this, side); },
        show(visible) { this.visible = visible; CNodeView.prototype._updateOwnDOM.call(this); },
    };
}

function satelliteControls() {
    panel = new WidgetPanel({parent: home, context: {},
        definition: {id: "test", title: "Test controls", widgets: ["time"]},
        registry: {time: {title: "Time", html: "<input>"}},
    });
    panel.setVisible(true);      // docks the composition in the left rail
    return panel;
}

const railOpen = () => getLeftSidebar().style.display === "block" && content.style.left === "250px";
const railClosed = () => getLeftSidebar().style.display === "none" && content.style.left === "0px";

beforeEach(() => {
    home = document.createElement("div");
    document.body.append(home);
    viewDivs = [];
    panel = null;
});
afterEach(() => {
    panel?.dispose();
    for (const div of viewDivs) div.remove();
    hideLeftSidebar(); hideRightSidebar();
    home.remove();
});

test("a view docked in an empty rail keeps the rail open", () => {
    dockableView().dock("left");
    expect(railOpen()).toBe(true);
});

test("hiding the widgets does not hide a view docked in the same rail", () => {
    satelliteControls();
    const view = dockableView();
    view.dock("left");
    panel.setVisible(false);
    expect(railOpen()).toBe(true);

    // The view was the last occupant that showed. When it hides, the rail closes.
    view.show(false);
    expect(railClosed()).toBe(true);
    view.show(true);
    expect(railOpen()).toBe(true);
});

test("a view can dock in a rail that holds only hidden widgets", () => {
    satelliteControls().setVisible(false);
    expect(railClosed()).toBe(true);
    dockableView().dock("left");
    expect(railOpen()).toBe(true);
});

test("moving a widget does not hide a view docked alone in the other rail", () => {
    dockableView().dock("right");
    satelliteControls();
    panel.place("time", "float");       // a placement change clears the widget from both rails
    expect(getRightSidebar().style.display).toBe("block");
    expect(content.style.right).toBe("250px");
});

test("the last widget can leave a rail that still holds a docked view", () => {
    satelliteControls();
    const view = dockableView();
    view.dock("left");
    panel.place(undefined, "right");
    expect(railOpen()).toBe(true);
    view.show(false);
    expect(railClosed()).toBe(true);
});

test("a rail closes when its last widget leaves and nothing else is in it", () => {
    satelliteControls();
    panel.place(undefined, "right");
    expect(railClosed()).toBe(true);
});

test("a rail with only hidden widgets gives its space back, and opens with them", () => {
    satelliteControls();
    expect(railOpen()).toBe(true);
    panel.setVisible(false);
    expect(railClosed()).toBe(true);
    panel.setVisible(true);
    expect(railOpen()).toBe(true);
});
