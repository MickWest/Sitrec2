/** @jest-environment jsdom */
import {initTooltips, TOOLTIP_DELAY_MS} from "../src/Tooltips";

let barButton, menuItem;
const hover = el => el.dispatchEvent(new MouseEvent("mouseover", {bubbles: true}));
const shownTip = () => document.querySelector(".sitrec-tooltip.visible");

beforeAll(() => initTooltips());
beforeEach(() => {
    jest.useFakeTimers();
    barButton = document.createElement("button");
    barButton.className = "view-uibar-icon";
    barButton.title = "New chat";
    menuItem = document.createElement("div");
    menuItem.className = "controller";
    menuItem.title = "Show the satellites";
    document.body.append(barButton, menuItem);
});
afterEach(() => {
    // A click ends any tip and its warm window, so each test starts cold.
    document.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
    barButton.remove();
    menuItem.remove();
    jest.useRealTimers();
});

test("a header-bar button gets the fast tooltip", () => {
    hover(barButton);
    expect(barButton.hasAttribute("title")).toBe(false);   // borrowed, so no native tip
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS);
    expect(shownTip()?.textContent).toBe("New chat");
});

test("a menu item keeps the browser's own tooltip", () => {
    hover(menuItem);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS * 4);
    expect(menuItem.getAttribute("title")).toBe("Show the satellites");
    expect(shownTip()).toBeNull();
});

test("moving from a bar button to a menu item hands the title back", () => {
    hover(barButton);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS);
    hover(menuItem);
    expect(barButton.getAttribute("title")).toBe("New chat");
    expect(menuItem.getAttribute("title")).toBe("Show the satellites");
    expect(shownTip()).toBeNull();
});
