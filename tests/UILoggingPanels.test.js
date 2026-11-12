/** @jest-environment jsdom */
import {buildMenuPath, buildPanelPath} from "../src/UILogging";
import {WidgetPanel} from "../src/WidgetPanel";
import {TimeEditor} from "../src/TimeEditor";
import {hideLeftSidebar, hideRightSidebar} from "../src/PageStructure";

// The usage log names a click by the path that the user sees. Native panels are not
// lil-gui elements, so they have their own path builder.
let content, home, panel;
beforeEach(() => {
    content = document.createElement("div"); content.id = "Content";
    home = document.createElement("div");
    document.body.append(content, home);
    panel = new WidgetPanel({parent: home, context: {},
        definition: {id: "test", title: "Test controls", widgets: ["observer"]},
        registry: {observer: {title: "Observer", html: `<button data-id="go">Go</button>
            <label><span>Latitude</span><input data-id="lat" type="number"></label>
            <input data-id="search" type="search" aria-label="Search place" placeholder="Place…">
            <div class="native-controls"><div class="native-control-pair"><span class="native-control-label">Flare Region</span>
                <div class="native-control"><label class="native-control-label">Look</label><div class="native-control-fields"><input type="checkbox" data-id="look"><span class="native-control-letter">L</span></div></div></div>
                <div class="native-control"><label class="native-control-label">Show satellites</label><div class="native-control-fields"><input type="checkbox" data-id="show"></div></div></div>`}},
    });
    panel.setVisible(true);
});
afterEach(() => {
    panel.dispose(); home.remove(); content.remove();
    hideLeftSidebar(); hideRightSidebar();
});
const el = id => panel.instances.get("observer").body.querySelector(`[data-id="${id}"]`);

test("a control in a widget has the path of the panel, the widget and its label", () => {
    expect(buildPanelPath(el("go"))).toBe("Test controls/Observer/Go");
    expect(buildPanelPath(el("lat"))).toBe("Test controls/Observer/Latitude");
    expect(buildPanelPath(el("search"))).toBe("Test controls/Observer/Search place");
    expect(buildPanelPath(el("show"))).toBe("Test controls/Observer/Show satellites");
    // A Main/Look pair has one name; the letter tells the two checkboxes apart.
    expect(buildPanelPath(el("look"))).toBe("Test controls/Observer/Flare Region L");
});

test("a widget title and the composition title give the path of the widget", () => {
    expect(buildPanelPath(panel.instances.get("observer").host.titleElement)).toBe("Test controls/Observer");
    expect(buildPanelPath(panel.host.titleElement)).toBe("Test controls");
});

test("the path of a control stays the same when its widget moves to a rail or a float", () => {
    panel.place("observer", "right");
    expect(buildPanelPath(el("go"))).toBe("Test controls/Observer/Go");
    panel.place("observer", "float");
    expect(buildPanelPath(el("go"))).toBe("Test controls/Observer/Go");
});

test("the placement menu of a widget is in the path of that widget", () => {
    const button = panel.instances.get("observer").host.element.querySelector(".widget-placement-button");
    expect(buildPanelPath(button)).toBe("Test controls/Observer/⋮");
    button.click();
    const item = [...document.querySelectorAll(".widget-placement-menu button")].find(entry => entry.textContent === "Dock right");
    expect(buildPanelPath(item)).toBe("Test controls/Observer/⋮/Dock right");
    panel.closePlacementMenu();
});

test("the time editor in a menu has a path that starts with the menu", () => {
    const menu = document.createElement("div");
    menu.className = "lil-gui";
    menu.innerHTML = '<button class="title">Time</button><div class="children"><div class="host"></div></div>';
    document.body.append(menu);
    const state = {now: new Date("2024-12-31T23:59:10Z"), start: new Date("2024-12-31T23:59:00Z"), frame: 300,
        offset: 0, useZone: false, zone: "UTC", paused: true, live: false, speed: 1, playbackSpeed: 1, canUndo: false};
    const editor = new TimeEditor(menu.querySelector(".host"), {zones: [], read: () => state, pause() {}});
    try {
        expect(buildPanelPath(editor.root.querySelector('[data-target="start"]'))).toBe("Time/Edit Start");
        expect(buildPanelPath(editor.root.querySelector('[data-part="hour"]'))).toBe("Time/Hour");
        expect(buildPanelPath(editor.root.querySelector('[data-id="paste"]'))).toBe("Time/Paste date and time");
        // The menu builder does not see the editor, so one click is not recorded two times.
        expect(buildMenuPath(editor.root.querySelector('[data-target="start"]'))).toBeNull();
    } finally {
        editor.dispose(); menu.remove();
    }
});

test("a menu control and an element outside a panel give no panel path", () => {
    const menu = document.createElement("div");
    menu.className = "lil-gui";
    menu.innerHTML = '<button class="title">Camera</button><div class="children"><div class="controller"><div class="name">Zoom</div><button>Reset</button></div></div>';
    const loose = document.createElement("button");
    loose.textContent = "Close";
    document.body.append(menu, loose);
    expect(buildPanelPath(menu.querySelector(".controller button"))).toBeNull();
    expect(buildMenuPath(menu.querySelector(".controller button"))).toBe("Camera/Zoom");
    expect(buildPanelPath(loose)).toBeNull();
    expect(buildPanelPath(content)).toBeNull();
    menu.remove(); loose.remove();
});
