/** @jest-environment jsdom */
import {initTooltips, setTooltip, TOOLTIP_DELAY_MS} from "../src/Tooltips";

let barButton, menuItem;
const hover = el => el.dispatchEvent(new MouseEvent("mouseover", {bubbles: true}));
const shownTip = () => document.querySelector(".sitrec-tooltip.visible");

beforeAll(() => initTooltips());
beforeEach(() => {
    jest.useFakeTimers();
    barButton = document.createElement("button");
    barButton.className = "view-uibar-icon";
    setTooltip(barButton, "New chat");
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

test("a header-bar button gets only the styled tooltip after 1.5 seconds", () => {
    hover(barButton);
    expect(barButton.getAttribute("title")).toBe(""); // blocks native and inherited titles
    expect(barButton.getAttribute("aria-label")).toBe("New chat");
    expect(TOOLTIP_DELAY_MS).toBe(1500);
    jest.advanceTimersByTime(1499);
    expect(shownTip()).toBeNull();
    jest.advanceTimersByTime(1);
    expect(shownTip()?.textContent).toBe("New chat");
});

test("a menu item keeps the browser's own tooltip", () => {
    hover(menuItem);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS * 4);
    expect(menuItem.getAttribute("title")).toBe("Show the satellites");
    expect(shownTip()).toBeNull();
});

test("leaving a bar button keeps its native tooltip disabled and leaves menu tooltips alone", () => {
    hover(barButton);
    jest.advanceTimersByTime(TOOLTIP_DELAY_MS);
    hover(menuItem);
    expect(barButton.getAttribute("title")).toBe("");
    expect(barButton.dataset.tooltip).toBe("New chat");
    expect(menuItem.getAttribute("title")).toBe("Show the satellites");
    expect(shownTip()).toBeNull();
});

test("control refreshes update the styled tooltip without reviving the native one or restarting the delay", () => {
    hover(barButton);
    jest.advanceTimersByTime(500);
    setTooltip(barButton, "Updated before showing");
    expect(barButton.title).toBe("");
    jest.advanceTimersByTime(1000);
    expect(shownTip()?.textContent).toBe("Updated before showing");
    setTooltip(barButton, "Updated while showing");
    expect(shownTip()?.textContent).toBe("Updated while showing");
    expect(barButton.title).toBe("");
    expect(barButton.getAttribute("aria-label")).toBe("Updated while showing");
    document.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
    expect(shownTip()).toBeNull();
    expect(barButton.title).toBe("");
});
