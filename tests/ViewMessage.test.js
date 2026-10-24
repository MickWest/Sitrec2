/**
 * @jest-environment jsdom
 */
// showViewMessage puts a short message at the top of one view. By default it is one line,
// cut with an ellipsis when the view is too narrow. {wrap: true} puts a longer notice on
// more lines instead, so that a half-width view shows all of it. The element is reused for
// the next message in the same view, so each message sets its own layout.

import {showViewMessage} from "../src/ViewMessage";

let view;

beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = "";
    const div = document.createElement("div");
    div.style.position = "absolute";
    document.body.appendChild(div);
    view = {div};
});

afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
});

const isOneLine = el => el.style.whiteSpace === "nowrap" && el.style.textOverflow === "ellipsis";
const isWrapped = el => el.style.whiteSpace === "normal" && el.style.textOverflow !== "ellipsis";

test("a message is one line, cut with an ellipsis, by default", () => {
    const el = showViewMessage(view, "Free look is off");
    expect(el.textContent).toBe("Free look is off");
    expect(isOneLine(el)).toBe(true);
    expect(el.style.overflow).toBe("hidden");
});

test("{wrap: true} puts the message on more lines, with no ellipsis", () => {
    const el = showViewMessage(view, "The tracks have no time in common, so the sitch was not re-timed.",
        {hold: 8000, wrap: true});
    expect(isWrapped(el)).toBe(true);
    expect(el.style.textOverflow).toBe("clip");
    // Still the same message box: centred at the top of the view, and clicks go through it.
    expect(el.parentElement).toBe(view.div);
    expect(el.getAttribute("role")).toBe("status");
    expect(el.style.pointerEvents).toBe("none");
});

test("the reused element takes the layout of each new message", () => {
    const first = showViewMessage(view, "A long notice that must be read to its end", {wrap: true});
    const second = showViewMessage(view, "Free look is off");
    expect(second).toBe(first);
    expect(isOneLine(second)).toBe(true);

    showViewMessage(view, "A long notice that must be read to its end", {wrap: true});
    expect(isWrapped(first)).toBe(true);
});

test("a wrapped message fades out like any other", () => {
    const el = showViewMessage(view, "A long notice", {hold: 8000, wrap: true});
    expect(el.style.opacity).toBe("1");
    jest.advanceTimersByTime(8000 + 600);
    expect(el.style.opacity).toBe("0");
    expect(el.textContent).toBe("");
});
