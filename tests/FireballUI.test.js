/** @jest-environment jsdom */
import { openFireballBrowser } from "../src/FireballUI";
import { parseGMNSummary } from "../src/FireballData";
jest.mock("../src/Globals", () => ({ Sit: { startTime: "2025-01-01T00:00:00Z" } }));
jest.mock("../src/DragDropHandler", () => ({ DragDropHandler: {} }));
jest.mock("../src/par", () => ({ par: {} }));
jest.mock("../src/FireballData", () => ({
    FIREBALL_LIMITS: "Coverage limits",
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
