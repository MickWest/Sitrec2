/**
 * @jest-environment jsdom
 */

// The two row looks of src/MenuRowLooks.js: a link row (a label and a button with a name) and
// a display row (a text that the user reads). Each is an ordinary controller, and the copy of
// a folder in a panel must have the same look.

window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));
global.ResizeObserver = global.ResizeObserver || class { observe() {} disconnect() {} };

import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";      // installs asLinkRow, asDisplayRow, mirrorFolderFrom

let containers;

function makeGUI(title = "menu") {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    return new GUI({container, autoPlace: false, title});
}

beforeEach(() => { containers = []; });
afterEach(() => containers.forEach(container => container.remove()));

test("a link row is a button with a label beside it, and a name that does not change", () => {
    const open = jest.fn();
    const folder = makeGUI().addFolder("Object 1");
    const row = folder.add({showTrackMenu: open}, "showTrackMenu").name("Balloon").asLinkRow("On Track", "link:onTrack");

    expect(row.domElement.classList.contains("lil-link-row")).toBe(true);
    expect(row.domElement.dataset.linkLabel).toBe("On Track");
    // the button's text is the name of the thing at the other end
    expect(row.domElement.querySelector("button").textContent).toBe("Balloon");
    row.domElement.querySelector("button").click();
    expect(open).toHaveBeenCalledTimes(1);

    // the other thing gets a new name: the text follows, the key of the row does not
    row.name("Weather Balloon");
    expect(row.domElement.querySelector("button").textContent).toBe("Weather Balloon");
    expect(row._signatureName).toBe("link:onTrack");
    // still found by its property, as the Sitrec API finds it
    expect(folder.controllers.find(c => c.property === "showTrackMenu")).toBe(row);
});

test("a link row without a given key takes one from its label", () => {
    const row = makeGUI().add({go: () => {}}, "go").asLinkRow("Object");
    expect(row._signatureName).toBe("link:Object");
});

test("a display row shows a text that the user can select and not edit", () => {
    const state = {text: "Camera position, FOV"};
    const row = makeGUI().add(state, "text").name("Used For").asDisplayRow();

    expect(row._displayOnly).toBe(true);
    expect(row.domElement.classList.contains("lil-display-row")).toBe(true);
    expect(row.$input.readOnly).toBe(true);
    expect(row.$input.tabIndex).toBe(-1);
    // not disabled: a disabled row is dim, and dim means "switched off" in these menus
    expect(row._disabled).toBe(false);
    expect(row.$input.value).toBe("Camera position, FOV");

    state.text = "Target";
    row.updateDisplay();
    expect(row.$input.value).toBe("Target");
});

test("the copy of a folder in a panel has the two looks, and follows the source", () => {
    const open = jest.fn();
    const state = {text: "Target"};
    const source = makeGUI().addFolder("Track 3");
    const link = source.add({showObjectMenu: open}, "showObjectMenu").name("Object 3").asLinkRow("Object", "link:object:1");
    const display = source.add(state, "text").name("Used For").asDisplayRow();

    const panel = makeGUI("Track: Track 3");
    panel.mirrorFolderFrom(source);
    const linkTwin = panel.controllers.find(c => c.property === "showObjectMenu");
    const displayTwin = panel.controllers.find(c => c.property === "text");

    expect(linkTwin.domElement.dataset.linkLabel).toBe("Object");
    expect(linkTwin._signatureName).toBe("link:object:1");
    expect(displayTwin._displayOnly).toBe(true);
    expect(displayTwin.$input.readOnly).toBe(true);

    // the button of the copy does what the button of the folder does
    linkTwin.domElement.querySelector("button").click();
    expect(open).toHaveBeenCalledTimes(1);

    // a new name and a new text reach the copy
    link.name("Gull");
    expect(linkTwin.domElement.querySelector("button").textContent).toBe("Gull");
    state.text = "Camera position";
    display.updateDisplay();
    expect(displayTwin.$input.value).toBe("Camera position");

    // a row that hides, hides in the copy
    link.hide();
    expect(linkTwin._hidden).toBe(true);
});
