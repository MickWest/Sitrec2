/**
 * @jest-environment jsdom
 */

// A folder's title note (src/FolderTitleNote.js): a tag at the right of the title row. The
// note must not change the title's TEXT, which is a key in several places, and its tooltip
// line must stay when the folder's own tooltip is set again.

window.matchMedia = window.matchMedia || (() => ({matches: false, addListener() {}, removeListener() {}}));
global.ResizeObserver = global.ResizeObserver || class { observe() {} disconnect() {} };

import GUI from "../src/js/lil-gui.esm";
import "../src/lil-gui-extras";      // installs setTitleNote, moveAfter, tooltip

let container, menu;

beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    menu = new GUI({container, autoPlace: false, title: "Contents"});
});

afterEach(() => {
    menu.destroy();
    container.remove();
});

test("the note is an attribute of the title, not a part of its text", () => {
    const folder = menu.addFolder("N97826");
    folder.setTitleNote("Camera");
    expect(folder.getTitleNote()).toBe("Camera");
    expect(folder.$title.dataset.note).toBe("Camera");
    // What GUI.moveAfter (textContent), the saved menu state (innerHTML) and getFolder
    // (innerText, which jsdom does not have) read: the title's own text, and no element.
    expect(folder.$title.textContent).toBe("N97826");
    expect(folder.$title.innerHTML).toBe("N97826");
    expect(folder.$title.children).toHaveLength(0);
});

test("a folder is still placed after another one by that folder's title", () => {
    const first = menu.addFolder("Location");
    menu.addFolder("Other");
    const moved = menu.addFolder("Material");
    first.setTitleNote("on Track 3");
    moved.moveAfter("Location");
    expect([...menu.$children.children].map(el => el.querySelector(".title").textContent))
        .toEqual(["Location", "Material", "Other"]);
});

test("the note stays through a rename, and goes when it is set to nothing", () => {
    const folder = menu.addFolder("Object 3");
    folder.setTitleNote("on Track 3");
    folder.title("Gull");
    expect(folder.getTitleNote()).toBe("on Track 3");
    expect(folder.$title.textContent).toBe("Gull");
    folder.setTitleNote("");
    expect(folder.getTitleNote()).toBe("");
    expect("note" in folder.$title.dataset).toBe(false);
});

test("the tip is one more line of the folder's tooltip, and a new tooltip keeps it", () => {
    const folder = menu.addFolder("N97826").tooltip("How this track is drawn");
    folder.setTitleNote("Camera", "Used for: Camera position");
    expect(folder.$title.title).toBe("How this track is drawn\nUsed for: Camera position");
    // a rename of an object sets the folder's tooltip again
    folder.tooltip("Reaper\nThe settings of this object");
    expect(folder.$title.title).toBe("Reaper\nThe settings of this object\nUsed for: Camera position");
    folder.setTitleNote("");
    expect(folder.$title.title).toBe("Reaper\nThe settings of this object");
});

test("a folder with no tooltip of its own shows the tip alone", () => {
    const folder = menu.addFolder("Track 3");
    folder.setTitleNote("Target", "Used for: Target");
    expect(folder.$title.title).toBe("Used for: Target");
});

test("the same note again writes nothing to the page", async () => {
    const folder = menu.addFolder("N97826").tooltip("How this track is drawn");
    folder.setTitleNote("Camera", "Used for: Camera position");
    const changes = [];
    const observer = new MutationObserver(list => changes.push(...list));
    observer.observe(folder.domElement, {subtree: true, childList: true, attributes: true, characterData: true});
    folder.setTitleNote("Camera", "Used for: Camera position");
    await Promise.resolve();
    observer.disconnect();
    expect(changes).toEqual([]);
});
