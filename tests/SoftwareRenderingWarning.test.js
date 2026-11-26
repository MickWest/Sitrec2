/** @jest-environment jsdom */

const benchmarkURL = "https://example.test/sitrec/tools/benchmark.html";
const software = rendererName => ({rendererName, softwareRendererDetected: true});
const hardware = {rendererName: "Example hardware adapter", softwareRendererDetected: false};
let updateWarning, removeWarning;

function panel() {
    return document.getElementById("software-rendering-warning");
}

function visiblePanel() {
    const element = panel();
    if (!element || element.hidden || element.style.display === "none") return null;
    return element;
}

beforeEach(() => {
    jest.resetModules();
    document.body.replaceChildren();
    window.localStorage.clear();
    require("../src/i18n").setLanguage("en");
    ({updateSoftwareRenderingWarning: updateWarning,
        removeSoftwareRenderingWarning: removeWarning} = require("../src/SoftwareRenderingWarning"));
});

afterEach(() => {
    jest.restoreAllMocks();
    document.body.replaceChildren();
});

test("hardware and unavailable diagnostics do not create a warning", () => {
    const createElement = jest.spyOn(document, "createElement");
    expect(() => updateWarning({}, hardware, benchmarkURL)).not.toThrow();
    expect(() => updateWarning({}, undefined, benchmarkURL)).not.toThrow();
    expect(visiblePanel()).toBeNull();
    expect(createElement).not.toHaveBeenCalled();
});

test("software rendering shows an accessible notice with its benchmark link", () => {
    updateWarning({}, software("Example software adapter"), benchmarkURL);
    const warning = visiblePanel();
    expect(warning).not.toBeNull();
    expect(warning.getAttribute("role")).toBe("status");
    expect(warning.textContent).toContain("Example software adapter");
    const link = Array.from(warning.querySelectorAll("a"))
        .find(element => element.textContent.trim() === "Open benchmark");
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).toBe(benchmarkURL);
    const dismiss = Array.from(warning.querySelectorAll("button"))
        .find(element => element.textContent.trim() === "Dismiss");
    expect(dismiss).toBeDefined();
});

test("repeated updates and two affected views share one panel", () => {
    const main = {}, look = {};
    updateWarning(main, software("Example software adapter"), benchmarkURL);
    updateWarning(main, software("Example software adapter"), benchmarkURL);
    updateWarning(look, software("Example software adapter"), benchmarkURL);
    expect(document.querySelectorAll("#software-rendering-warning")).toHaveLength(1);
    expect(visiblePanel()).not.toBeNull();
    removeWarning(main);
    expect(visiblePanel()).not.toBeNull();
    removeWarning(look);
    expect(visiblePanel()).toBeNull();
});

test("one view recovering to hardware does not hide another software view", () => {
    const main = {}, look = {};
    updateWarning(main, software("First software adapter"), benchmarkURL);
    updateWarning(look, software("Second software adapter"), benchmarkURL);
    updateWarning(main, hardware, benchmarkURL);
    expect(visiblePanel()).not.toBeNull();
    updateWarning(look, hardware, benchmarkURL);
    expect(visiblePanel()).toBeNull();
});

test("removing an unrelated or already removed renderer leaves other views represented", () => {
    const softwareView = {}, hardwareView = {};
    updateWarning(softwareView, software("Example software adapter"), benchmarkURL);
    updateWarning(hardwareView, hardware, benchmarkURL);
    removeWarning(hardwareView);
    removeWarning(hardwareView);
    removeWarning({});
    expect(visiblePanel()).not.toBeNull();
    removeWarning(softwareView);
    expect(visiblePanel()).toBeNull();
});

test("a later software context can show a new warning after all previous contexts recover", () => {
    const renderer = {};
    updateWarning(renderer, software("Example software adapter"), benchmarkURL);
    updateWarning(renderer, hardware, benchmarkURL);
    expect(visiblePanel()).toBeNull();
    updateWarning(renderer, software("Recovered software context"), benchmarkURL);
    expect(visiblePanel()).not.toBeNull();
    expect(visiblePanel().textContent).toContain("Recovered software context");
});

test("dismissal stays effective for all subsequent views on this page", () => {
    const first = {}, second = {};
    updateWarning(first, software("First software adapter"), benchmarkURL);
    const dismiss = Array.from(visiblePanel().querySelectorAll("button"))
        .find(element => element.textContent.trim() === "Dismiss");
    dismiss.click();
    expect(visiblePanel()).toBeNull();
    updateWarning(first, software("First software adapter"), benchmarkURL);
    updateWarning(second, software("Second software adapter"), benchmarkURL);
    expect(visiblePanel()).toBeNull();
    removeWarning(first);
    removeWarning(second);
    updateWarning({}, software("New software view"), benchmarkURL);
    expect(visiblePanel()).toBeNull();
});

test("renderer strings are displayed literally instead of creating markup", () => {
    const rendererName = '<img src="example" onerror="window.rendererMarkupExecuted=true">';
    updateWarning({}, software(rendererName), benchmarkURL);
    expect(visiblePanel().textContent).toContain(rendererName);
    expect(visiblePanel().querySelector("img")).toBeNull();
    expect(window.rendererMarkupExecuted).toBeUndefined();
});

test("a DOM creation failure cannot interrupt renderer startup and can be retried", () => {
    const renderer = {};
    const createElement = jest.spyOn(document, "createElement").mockImplementationOnce(() => {
        throw new Error("Example DOM creation failure");
    });
    expect(() => updateWarning(renderer, software("Example software adapter"), benchmarkURL)).not.toThrow();
    createElement.mockRestore();
    updateWarning(renderer, software("Example software adapter"), benchmarkURL);
    expect(visiblePanel()).not.toBeNull();
});

test("a DOM removal failure cannot interrupt renderer disposal", () => {
    const renderer = {};
    updateWarning(renderer, software("Example software adapter"), benchmarkURL);
    jest.spyOn(panel(), "remove").mockImplementationOnce(() => {
        throw new Error("Example DOM removal failure");
    });
    expect(() => removeWarning(renderer)).not.toThrow();
});
