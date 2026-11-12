/**
 * An option of showChoice with disabled:true is shown and cannot be chosen: not by a
 * click, and not by Enter. The stale build dialog uses it (src/StaleBuildRecovery.js).
 * @jest-environment jsdom
 */
jest.mock("../src/Globals", () => ({Globals: {validationMode: false}}));
jest.mock("../src/par", () => ({par: {paused: false}}));

import {showChoice} from "../src/showError";

beforeEach(() => { document.body.innerHTML = ""; });

const button = (text) => [...document.querySelectorAll("button")].find((b) => b.textContent.includes(text));
const press = (key) => document.dispatchEvent(new KeyboardEvent("keydown", {key, bubbles: true}));

test("a disabled option does nothing, and the other options work", async () => {
    const answer = showChoice("What now?", {options: [
        {label: "Save and reload", value: "save"},
        {label: "Temporary save", value: "temporary", disabled: true},
        {label: "Cancel", value: null, cancel: true},
    ]});
    expect(button("Temporary save").disabled).toBe(true);
    expect(button("Save and reload").disabled).toBe(false);
    button("Temporary save").click();
    expect(document.querySelectorAll("button")).toHaveLength(3);        // the dialog is still open
    button("Save and reload").click();
    await expect(answer).resolves.toBe("save");
});

test("Enter and the first focus go to an option that can be chosen", async () => {
    const answer = showChoice("What now?", {options: [
        {label: "First", value: "first", primary: true, disabled: true},
        {label: "Second", value: "second"},
        {label: "Cancel", value: null, cancel: true},
    ]});
    expect(document.activeElement).toBe(button("Second"));
    press("Enter");
    await expect(answer).resolves.toBe("second");
});
