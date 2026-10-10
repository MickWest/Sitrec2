/** @jest-environment jsdom */
import { openFireballBrowser, showFireballDetails } from "../src/FireballUI";
import { parseGMNSummary } from "../src/FireballData";
import { NodeMan } from "../src/Globals";
import { LLAToECEF } from "../src/LLA-ECEF-ENU";
jest.mock("../src/Globals", () => ({
    Sit: { startTime: "2025-01-01T00:00:00Z", lat: 32, lon: -118 },
    Globals: { equatorRadius: 6378137, polarRadius: 6356752.314245 },
    NodeMan: { get: jest.fn(() => undefined) },
}));
jest.mock("../src/DragDropHandler", () => ({ DragDropHandler: {} }));
jest.mock("../src/par", () => ({ par: {} }));
jest.mock("../src/FireballData", () => ({
    ...jest.requireActual("../src/FireballData"),
    GMN_SOURCE: "https://globalmeteornetwork.org/data/",
    parseGMNSummary: jest.fn(() => ({ events: [], rejected: 0 })),
    nearbyFireballs: jest.fn(() => []),
}));
beforeEach(() => {
    document.body.replaceChildren();
    HTMLDialogElement.prototype.showModal = function () {};
    jest.clearAllMocks();
});
test("new import invalidates pending reads and snapshots the original source URL", async () => {
    openFireballBrowser();
    const input = document.querySelector('input[type="file"]');
    const source = document.querySelector('input[type="url"]');
    let resolveOld;
    const oldFile = { name: "old.txt", size: 10, text: () => new Promise(resolve => resolveOld = resolve) };
    Object.defineProperty(input, "files", { configurable: true, value: [oldFile] });
    source.value = "https://globalmeteornetwork.org/old.txt";
    const oldImport = input.onchange();
    Object.defineProperty(input, "files", { configurable: true, value: [{ name: "new.txt", size: 10, text: async () => "new" }] });
    source.value = "https://globalmeteornetwork.org/new.txt";
    await input.onchange();
    resolveOld("old");
    await oldImport;
    expect(parseGMNSummary).toHaveBeenCalledTimes(1);
    expect(parseGMNSummary).toHaveBeenCalledWith("new", "https://globalmeteornetwork.org/new.txt");
});
const searchField = (label) =>
    [...document.querySelectorAll("dialog label")].find((l) => l.textContent.startsWith(label + " ")).querySelector("input");
test("the default search center is the look camera's position, not the start-up origin", () => {
    NodeMan.get.mockImplementation((id) => (id === "lookCamera" ? { camera: { position: LLAToECEF(64.1355, -21.8954, 3000) } } : undefined));
    openFireballBrowser();
    expect(Number(searchField("Latitude").value)).toBeCloseTo(64.1355, 4);
    expect(Number(searchField("Longitude").value)).toBeCloseTo(-21.8954, 4);
    NodeMan.get.mockImplementation(() => undefined);
});
test("without a look camera the search starts at the sitch origin", () => {
    openFireballBrowser();
    expect(searchField("Latitude").value).toBe("32");
    expect(searchField("Longitude").value).toBe("-118");
});
test("closing the importer invalidates an in-flight read", async () => {
    openFireballBrowser();
    const input = document.querySelector('input[type="file"]');
    let resolveRead;
    Object.defineProperty(input, "files", { value: [{ name: "old.txt", size: 10, text: () => new Promise(resolve => resolveRead = resolve) }] });
    const pending = input.onchange();
    document.querySelector("dialog").dispatchEvent(new Event("close"));
    resolveRead("old");
    await pending;
    expect(parseGMNSummary).not.toHaveBeenCalled();
});
const sampleEvent = (url, network) => ({
    kind: "sitrec-fireball-v1",
    id: "event-1",
    source: { network, url, license: "Source license" },
    altitudeReference: "WGS84 ellipsoid",
    pathMethod: "measured time-tagged samples",
    samples: [
        { time: "2025-01-01T00:00:00.000Z", lat: 35, lon: -107, altitude: 100000 },
        { time: "2025-01-01T00:00:01.000Z", lat: 34.9, lon: -107.1, altitude: 70000 },
    ],
});
test("a source URL on another host is shown as text, never as a link", () => {
    showFireballDetails(sampleEvent("https://example.org/report?id=7", "Other network"));
    const dialog = document.querySelector("dialog");
    expect([...dialog.querySelectorAll("a")].some(a => a.href.includes("example.org"))).toBe(false);
    expect(dialog.textContent).toContain("Original source: https://example.org/report?id=7");
});
test("a GMN source URL stays a link", () => {
    const url = "https://globalmeteornetwork.org/data/traj_summary_data/daily/traj_summary_20251226.txt";
    showFireballDetails(sampleEvent(url, "Global Meteor Network"));
    const a = [...document.querySelectorAll("dialog a")].find(a => a.textContent === "Original source");
    expect(a.href).toBe(url);
    expect(a.rel).toBe("noopener noreferrer");
});
test("a source URL on the license host is text too: only GMN source URLs become links", () => {
    showFireballDetails(sampleEvent("https://creativecommons.org/anything?id=7", "Other network"));
    const dialog = document.querySelector("dialog");
    expect([...dialog.querySelectorAll("a")].some(a => a.textContent === "Original source")).toBe(false);
    expect(dialog.textContent).toContain("Original source: https://creativecommons.org/anything?id=7");
});
