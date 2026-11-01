import {
    cancelDropdownHold,
    dropdownCloseCause,
    formatDropdownClose,
    runWhenDropdownsClosed,
} from "../src/DropdownWatch";

const CLOSED_AT = 5000;

function closeRecord(overrides = {}) {
    return {
        label: "Edit: G-EZGY/Model",
        valueBefore: "F/A-18F",
        valueAfter: "F/A-18F",
        openedAt: 3000,
        closedAt: CLOSED_AT,
        inPageAtClose: true,
        inPageAtEnd: true,
        focusedAtClose: true,
        changeEvents: 0,
        optionChanges: 0,
        focusLostAt: null,
        mouseLeftAt: null,
        windowBlurAt: null,
        longestStall: 52,
        longestStallAt: CLOSED_AT - 400,
        ...overrides,
    };
}

describe("dropdownCloseCause", () => {
    test("no pick and no page action gives none seen", () => {
        expect(dropdownCloseCause(closeRecord())).toBe("none seen");
    });

    test("a change event with a new value is a pick", () => {
        const record = closeRecord({changeEvents: 1, valueAfter: "737 MAX 8 BA"});
        expect(dropdownCloseCause(record)).toBe("pick");
    });

    test("a pick that rebuilds the panel is still a pick", () => {
        const record = closeRecord({changeEvents: 1, valueAfter: "737 MAX 8 BA", inPageAtClose: false, inPageAtEnd: false});
        expect(dropdownCloseCause(record)).toBe("pick");
    });

    test("a change event that the value does not keep is a pick undone", () => {
        expect(dropdownCloseCause(closeRecord({changeEvents: 1}))).toBe("pick undone");
    });

    test("a select that left the page with no pick is a rebuild", () => {
        expect(dropdownCloseCause(closeRecord({inPageAtClose: false, inPageAtEnd: false}))).toBe("panel rebuilt");
    });

    test("focus lost before the close names what went with it", () => {
        const focusLostAt = CLOSED_AT - 20;
        expect(dropdownCloseCause(closeRecord({focusLostAt}))).toBe("focus lost");
        expect(dropdownCloseCause(closeRecord({focusLostAt, mouseLeftAt: CLOSED_AT - 25}))).toBe("mouse left panel");
        expect(dropdownCloseCause(closeRecord({focusLostAt, windowBlurAt: CLOSED_AT - 25}))).toBe("window lost focus");
    });

    test("focus lost after the close did not cause it", () => {
        expect(dropdownCloseCause(closeRecord({focusLostAt: CLOSED_AT + 900}))).toBe("none seen");
    });
});

describe("runWhenDropdownsClosed", () => {
    const realCSS = globalThis.CSS;
    let isMenuOpen;
    let menu;
    let logSpy;

    beforeEach(() => {
        jest.useFakeTimers();
        globalThis.CSS = {supports: () => true};
        isMenuOpen = false;
        menu = {$title: {textContent: "Object 1"}, domElement: {querySelector: () => (isMenuOpen ? {} : null)}};
        logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        jest.useRealTimers();
        globalThis.CSS = realCSS;
        logSpy.mockRestore();
    });

    test("runs at once when no dropdown is open, and logs nothing", () => {
        const action = jest.fn();
        runWhenDropdownsClosed(menu, action);
        expect(action).toHaveBeenCalledTimes(1);
        expect(logSpy).not.toHaveBeenCalled();
    });

    test("waits for an open dropdown to close, runs once, and logs the wait", () => {
        isMenuOpen = true;
        const action = jest.fn();
        runWhenDropdownsClosed(menu, action);

        jest.advanceTimersByTime(5000);
        expect(action).not.toHaveBeenCalled();

        isMenuOpen = false;
        jest.advanceTimersByTime(1000);
        expect(action).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls[0][0]).toContain('"Object 1" panel update waited');
    });

    test("a newer action replaces the waiting one", () => {
        isMenuOpen = true;
        const older = jest.fn();
        const newer = jest.fn();
        runWhenDropdownsClosed(menu, older);
        runWhenDropdownsClosed(menu, newer);

        isMenuOpen = false;
        jest.advanceTimersByTime(1000);
        expect(older).not.toHaveBeenCalled();
        expect(newer).toHaveBeenCalledTimes(1);
    });

    test("a call after the close does not run the action twice", () => {
        isMenuOpen = true;
        const action = jest.fn();
        runWhenDropdownsClosed(menu, action);

        isMenuOpen = false;
        runWhenDropdownsClosed(menu, action);
        jest.advanceTimersByTime(1000);
        expect(action).toHaveBeenCalledTimes(1);
    });

    test("a destroyed menu drops its waiting action", () => {
        isMenuOpen = true;
        const action = jest.fn();
        runWhenDropdownsClosed(menu, action);

        cancelDropdownHold(menu);
        isMenuOpen = false;
        jest.advanceTimersByTime(1000);
        expect(action).not.toHaveBeenCalled();
    });

    test("a browser that cannot report an open menu runs at once", () => {
        globalThis.CSS = {supports: () => false};
        menu.domElement.querySelector = () => {
            throw new Error("unknown selector");
        };
        const action = jest.fn();
        runWhenDropdownsClosed(menu, action);
        expect(action).toHaveBeenCalledTimes(1);
    });
});

describe("formatDropdownClose", () => {
    test("times are relative to the close, and an event that did not happen reads no", () => {
        const record = closeRecord({focusLostAt: CLOSED_AT + 12, mouseLeftAt: CLOSED_AT - 30});
        const line = formatDropdownClose(record, "none seen", 3);
        expect(line).toContain('Dropdown "Edit: G-EZGY/Model": cause=none seen');
        expect(line).toContain('value "F/A-18F" -> "F/A-18F"');
        expect(line).toContain("open 2000 ms");
        expect(line).toContain("focusLost=+12 ms");
        expect(line).toContain("mouseLeft=-30 ms");
        expect(line).toContain("windowBlur=no");
        expect(line).toContain("longestStall=52 ms at -400 ms");
        expect(line).toContain("noPickCount=3");
    });
});
