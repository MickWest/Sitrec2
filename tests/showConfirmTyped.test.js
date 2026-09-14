/**
 * A confirmation that asks for a typed word (showConfirm's typeToConfirm): nothing
 * but the cancel option can be chosen until the word is typed exactly.
 * @jest-environment jsdom
 */
jest.mock("../src/Globals", () => ({Globals: {validationMode: false}}));
jest.mock("../src/par", () => ({par: {paused: false}}));

import {showConfirm} from "../src/showError";

beforeEach(() => { document.body.innerHTML = ""; });

const buttons = () => [...document.querySelectorAll("button")];
const press = (key) => document.dispatchEvent(new KeyboardEvent("keydown", {key, bubbles: true}));
const type = (text) => {
    const input = document.querySelector("input");
    input.value = text;
    input.dispatchEvent(new Event("input"));
};

test("the confirming button and Enter wait for the exact word", async () => {
    const answer = showConfirm("Delete it all?", {yesLabel: "Flush the cache", noLabel: "Keep the cache", typeToConfirm: "Flush"});
    const yes = buttons().find((b) => b.textContent.includes("Flush the cache"));
    const keep = buttons().find((b) => b.textContent.includes("Keep the cache"));
    expect(yes.disabled).toBe(true);
    expect(keep.disabled).toBe(false);
    expect(document.activeElement).toBe(document.querySelector("input"));
    press("Enter");                       // still disarmed: nothing happens
    yes.click();                          // a disabled button does nothing
    type("flush");                        // the case matters
    expect(yes.disabled).toBe(true);
    type(" Flush ");                      // surrounding spaces do not
    expect(yes.disabled).toBe(false);
    press("Enter");
    await expect(answer).resolves.toBe(true);
    expect(document.querySelector("input")).toBeNull();
});

test("Escape and the cancel option need no word", async () => {
    const answer = showConfirm("Delete?", {typeToConfirm: "Flush"});
    press("Escape");
    await expect(answer).resolves.toBe(false);
    const again = showConfirm("Delete?", {noLabel: "Keep it", typeToConfirm: "Flush"});
    buttons().find((b) => b.textContent.includes("Keep it")).click();
    await expect(again).resolves.toBe(false);
});

test("without the option the dialog is as before: Enter confirms at once", async () => {
    const answer = showConfirm("Sure?");
    expect(document.querySelector("input")).toBeNull();
    press("Enter");
    await expect(answer).resolves.toBe(true);
});
