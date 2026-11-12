/** @jest-environment jsdom */
import {WidgetPanel} from "../src/WidgetPanel";
import {getLeftSidebar, getRightSidebar, hideLeftSidebar, hideRightSidebar} from "../src/PageStructure";

let panel, home, hud, content, disposal, activation;
beforeEach(() => {
    content = document.createElement("div"); content.id = "Content"; document.body.append(content);
    home = document.createElement("div"); hud = document.createElement("div"); document.body.append(home, hud);
    disposal = jest.fn(); activation = jest.fn();
    panel = new WidgetPanel({parent: home, context: {},
        definition: {id: "test", title: "Test controls", widgets: ["time", "observer", {type: "info", home: "sky"}]},
        homes: {sky: hud}, registry: {
            time: {title: "Time", html: '<input aria-label="Draft time">', mount: () => ({dispose: disposal, setActive: activation})},
            observer: {title: "Observer", html: '<input aria-label="Latitude">'},
            info: {title: "Information", html: '<strong>3 satellites</strong>'},
        },
    });
    panel.setVisible(true);
});
afterEach(() => {
    panel?.dispose(); home.remove(); hud.remove(); content.remove();
    hideLeftSidebar(); hideRightSidebar();
});

test("native widgets share rails without rendering legacy GUI", () => {
    expect(panel.host.element.closest("#LeftSidebar")).toBe(getLeftSidebar());
    expect(panel.host.element.querySelector(".lil-gui")).toBeNull();
    expect(content.style.left).toBe("250px");
    panel.place("time", "right");
    expect(panel.instances.get("time").host.element.closest("#RightSidebar")).toBe(getRightSidebar());
    expect(content.style.right).toBe("250px");
});

test("moving and restoring preserves input drafts and focused elements", () => {
    const instance = panel.instances.get("time"), input = instance.body.querySelector("input");
    input.value = "2020-04"; input.focus();
    panel.place("time", "float", {x: 120, y: 70});
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("2020-04");
    panel.place("time", "right");
    expect(document.activeElement).toBe(input);
    panel.recover("time");
    expect(instance.host.element.parentElement).toBe(panel.host.contentElement);
    expect(input.value).toBe("2020-04");
    expect(instance.returnButton.hidden).toBe(true);
});

test("hide and collapse preserve placement without empty dock space", () => {
    panel.place("time", "right");
    const instance = panel.instances.get("time");
    panel.setVisible(false);
    expect(instance.host.placementElement.hidden).toBe(true);
    expect(content.style.left).toBe("0px");
    expect(content.style.right).toBe("0px");
    panel.setVisible(true, false);
    expect(panel.instances.get("info").host.element.hidden).toBe(false);
    expect(instance.host.placementElement.hidden).toBe(false);
    expect(panel.host.placementElement.hidden).toBe(true);
    panel.setVisible(true, true);
    expect(instance.host.placement).toBe("right");
    expect(instance.host.placementElement.hidden).toBe(false);
});

test("layout persists by instance ID including collapsed detached widgets", () => {
    panel.place("time", "float", {x: 120, y: 70});
    panel.instances.get("time").host.open(false);
    panel.hide("observer");
    panel.place(undefined, "right");
    const saved = panel.getState();
    panel.reset();
    panel.instances.get("time").host.title = "Renamed time";
    panel.setState(saved);
    expect(panel.host.placement).toBe("right");
    expect(panel.instances.get("time").host.floating).toBe(true);
    expect(panel.instances.get("time").host.closed).toBe(true);
    expect(panel.instances.get("observer").hidden).toBe(true);
});

test("info widgets float and return to their sky home", () => {
    panel.place("info", "float");
    const instance = panel.instances.get("info");
    expect(instance.returnButton.hidden).toBe(false);
    instance.returnButton.click();
    expect(instance.host.element.parentElement).toBe(hud);
    panel.hide("info");
    expect(instance.returnButton.hidden).toBe(false);
    instance.returnButton.click();
    expect(instance.host.element.hidden).toBe(false);
});

test("placement commands work without dragging and dispose all detached DOM", () => {
    const instance = panel.instances.get("time");
    const button = instance.host.element.querySelector(".widget-placement-button");
    button.click();
    const menu = document.querySelector(".widget-placement-menu");
    expect(menu.contains(document.activeElement)).toBe(true);
    [...menu.children].find(item => item.textContent === "Dock right").click();
    expect(instance.host.placement).toBe("right");
    expect(document.activeElement).toBe(instance.host.titleElement);
    panel.place("info", "float");
    panel.dispose(); panel = null;
    expect(document.querySelector(".widget-window")).toBeNull();
    expect(document.querySelector(".widget-placement-menu")).toBeNull();
    expect(disposal).toHaveBeenCalledTimes(1);
    expect(content.style.left).toBe("0px");
    expect(content.style.right).toBe("0px");
});

test("a composition can merge related widget types into one widget", () => {
    const calls = [];
    const registry = {
        camera: {title: "Camera", collapsed: true, html: '<input aria-label="Pan">',
            mount: () => ({setActive: active => calls.push(`camera ${active}`), dispose: () => calls.push("camera disposed")})},
        aim: {title: "Aim", html: "<button>Look</button>", mount: () => ({setActive: active => calls.push(`aim ${active}`)})},
    };
    const merged = new WidgetPanel({parent: home, context: {}, registry,
        definition: {id: "merged", title: "Merged controls", widgets: [{type: "camera", merge: ["aim"], collapsed: false}]}});
    try {
        merged.setVisible(true);
        // One widget with the title of the first type. The merged type has no host of its own.
        expect([...merged.instances.keys()]).toEqual(["camera"]);
        const instance = merged.instances.get("camera");
        expect(instance.host.title).toBe("Camera");
        expect(merged.host.element.querySelectorAll('[data-widget-id="aim"]').length).toBe(0);
        // The content of each type is in the same host, in the order of the definition.
        expect(instance.bodies.map(body => body.dataset.widgetPart)).toEqual(["camera", "aim"]);
        expect(instance.bodies.every(body => body.parentElement === instance.host.contentElement)).toBe(true);
        expect(instance.bodies[0].querySelector("input")).toBeTruthy();
        expect(instance.bodies[1].querySelector("button").textContent).toBe("Look");
        // The definition opens it, and each part follows the state of the one widget.
        expect(instance.host.closed).toBe(false);
        expect(calls).toEqual(["camera true", "aim true"]);
        merged.hide("camera");
        expect(calls.slice(2)).toEqual(["camera false", "aim false"]);
    } finally {
        merged.dispose();
    }
    expect(calls.at(-1)).toBe("camera disposed");
    expect(() => new WidgetPanel({parent: home, context: {}, registry,
        definition: {id: "bad", title: "Bad", widgets: [{type: "camera", merge: ["missing"]}]}})).toThrow("Unknown widget: missing");
});

test("titles and template text come from the string file by key", () => {
    const keyed = new WidgetPanel({parent: home, context: {},
        definition: {id: "keyed", titleKey: "panels.satellite.title", widgets: ["observer"]},
        registry: {observer: {titleKey: "panels.widgets.observer.title",
            html: '<button data-i18n="panels.widgets.observer.go" data-i18n-title="panels.widgets.observer.search.tooltip"></button>'
                + '<input data-i18n-placeholder="panels.widgets.observer.search.placeholder" data-i18n-label="panels.widgets.observer.search.label">'}},
    });
    try {
        const instance = keyed.instances.get("observer");
        expect(keyed.host.title).toBe("Satellite Controls");
        expect(instance.host.title).toBe("Observer location");
        expect(instance.body.querySelector("button").textContent).toBe("Go");
        expect(instance.body.querySelector("button").title).toBe("Enter a place name or latitude, longitude.");
        expect(instance.body.querySelector("input").placeholder).toBe("Place or coordinates…");
        expect(instance.body.querySelector("input").getAttribute("aria-label")).toBe("Search observer location");
        expect(instance.returnButton.title).toBe("Return Observer location to Satellite Controls");
    } finally {
        keyed.dispose();
    }
});

test("reveal shows a widget where it is, and floats it only from a collapsed composition", () => {
    // At home in an open composition: it stays at home and opens.
    panel.instances.get("time").host.open(false);
    panel.hide("time");
    panel.reveal("time");
    expect(panel.instances.get("time").hidden).toBe(false);
    expect(panel.instances.get("time").host.detached).toBe(false);
    expect(panel.instances.get("time").host.closed).toBe(false);
    // In a rail: it stays in the rail.
    panel.place("observer", "right");
    panel.hide("observer");
    panel.reveal("observer");
    expect(panel.instances.get("observer").host.placement).toBe("right");
    expect(panel.instances.get("observer").host.element.hidden).toBe(false);
    // At home in a collapsed composition there is no place to show it, so it floats.
    panel.setVisible(true, false);
    panel.reveal("time");
    expect(panel.instances.get("time").host.floating).toBe(true);
    expect(panel.instances.get("time").host.element.hidden).toBe(false);
});

test("new floats do not start one on top of the other", () => {
    panel.place("time", "float");
    panel.place("observer", "float");
    const first = panel.instances.get("time").host.placementElement.style, second = panel.instances.get("observer").host.placementElement.style;
    expect(parseFloat(second.left)).toBeGreaterThan(parseFloat(first.left));
    expect(parseFloat(second.top)).toBeGreaterThan(parseFloat(first.top));
});

describe("a title drag", () => {
    const pointer = (type, target, x, y) => target.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y}));
    const dragTitle = (title, x, y) => {
        pointer("pointerdown", title, 10, 10);
        pointer("pointermove", document, 40, 40);
        pointer("pointermove", document, x, y);
        pointer("pointerup", document, x, y);
    };

    test("the click that ends the drag does not open or close the widget", () => {
        const host = panel.instances.get("time").host;
        dragTitle(host.titleElement, 300, 200);
        expect(host.placement).toBe("float");
        host.titleElement.click();              // the browser sends it in the same task as the release
        expect(host.closed).toBe(false);
    });

    test("one click after the drag opens or closes the widget, also when no click ended the drag", async () => {
        // The browser sends no click at the end of a drag that moved the widget to a new
        // container. The next click of the user must not be lost.
        const host = panel.instances.get("time").host;
        dragTitle(host.titleElement, 300, 200);
        await new Promise(resolve => setTimeout(resolve, 0));
        host.titleElement.click();
        expect(host.closed).toBe(true);
        host.titleElement.click();
        expect(host.closed).toBe(false);
    });

    test("a cancelled drag puts the widget back and does not cancel the next click", async () => {
        const host = panel.instances.get("time").host;
        pointer("pointerdown", host.titleElement, 10, 10);
        pointer("pointermove", document, 200, 200);
        expect(host.placement).toBe("float");
        pointer("pointercancel", document, 200, 200);
        expect(host.placement).toBe("home");
        await new Promise(resolve => setTimeout(resolve, 0));
        host.titleElement.click();
        expect(host.closed).toBe(true);
    });
});

test("the refresh reaches only the widgets that are in view", () => {
    const updates = [];
    const live = new WidgetPanel({parent: home, context: {},
        definition: {id: "live", title: "Live", widgets: ["shown", {type: "closed", collapsed: true}]},
        registry: {shown: {title: "Shown", mount: () => ({update: () => updates.push("shown")})},
            closed: {title: "Closed", mount: () => ({update: () => updates.push("closed")})}},
    });
    try {
        live.setVisible(true);
        updates.length = 0;
        live.update();
        expect(updates).toEqual(["shown"]);
        // A widget that comes into view refreshes at once.
        live.instances.get("closed").host.open();
        expect(updates).toEqual(["shown", "closed"]);
    } finally {
        live.dispose();
    }
});

test("small viewport rails overlay content and floating headers remain reachable", () => {
    const width = window.innerWidth, height = window.innerHeight;
    Object.defineProperty(window, "innerWidth", {value: 320, configurable: true});
    Object.defineProperty(window, "innerHeight", {value: 240, configurable: true});
    try {
        window.dispatchEvent(new Event("resize"));
        expect(content.style.left).toBe("0px");
        panel.place("time", "float", {x: 1800, y: 900});
        const host = panel.instances.get("time").host;
        expect(parseFloat(host.placementElement.style.left)).toBeLessThanOrEqual(66);
        expect(parseFloat(host.placementElement.style.top)).toBeLessThanOrEqual(180);
        expect(parseFloat(host.element.style.maxHeight)).toBeLessThanOrEqual(60);
    } finally {
        Object.defineProperty(window, "innerWidth", {value: width, configurable: true});
        Object.defineProperty(window, "innerHeight", {value: height, configurable: true});
        window.dispatchEvent(new Event("resize"));
    }
});
