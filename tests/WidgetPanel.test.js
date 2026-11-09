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
