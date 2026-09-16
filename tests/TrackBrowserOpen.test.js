/** @jest-environment jsdom */

jest.mock("../src/Globals", () => ({FileManager: {}, Globals: {}}));
jest.mock("../src/DragDropHandler", () => ({DragDropHandler: {uploadDroppedFiles: jest.fn()}}));
jest.mock("../src/showError", () => ({showError: jest.fn(), showErrorOnce: jest.fn()}));
jest.mock("../src/TrackFiles/TrackFileProbe", () => ({
    isProbeableTrackName: jest.fn(), probeTrackFile: jest.fn(), summarizeTrackFile: jest.fn(),
    trackFileTrackCount: jest.fn(),
}));
jest.mock("../src/analysis/BotBenchIngest", () => ({
    botBenchExplicitFileRole: jest.fn(), botBenchScenarioBase: jest.fn(),
}));
jest.mock("../src/analysis/BotBenchCacheIndex", () => ({CACHE_BLOB_DIR: ".botbench-cache"}));
jest.mock("../src/analysis/BotBenchUI", () => ({openBotBenchWithEntries: jest.fn()}));
jest.mock("../src/analysis/BotBenchImageCapture", () => ({
    imageDirFor: jest.fn(), imageNameFor: jest.fn(), IMAGE_DIR: "SitrecImage",
}));
jest.mock("../src/TraverseHypotheses", () => ({
    VIZ: {truth: "#f48fb1", camera: "#80deea", target: "#ef9a9a"},
}));
jest.mock("../src/FileHandoff", () => ({putFileHandoff: jest.fn(async () => "handoff-key")}));

import {CTrackBrowser} from "../src/CTrackBrowser";
import {putFileHandoff} from "../src/FileHandoff";

test("Open as New Sitch hands the file to a new tab and leaves this tab in place", async () => {
    window.history.replaceState({}, "", "/sitrec/?custom=current#frame");
    const originalURL = window.location.href;

    let releaseFile;
    const file = new File(["track"], "drone_001.all.csv", {type: "text/csv"});
    const getFile = jest.fn(() => new Promise(resolve => { releaseFile = () => resolve(file); }));
    const entry = {key: "drone", relativePath: "All/drone_001.all.csv", getFile};
    const popup = {
        document: {open: jest.fn(), write: jest.fn()},
        location: {href: ""},
        close: jest.fn(),
    };
    window.open = jest.fn(() => popup);

    const browser = new CTrackBrowser({});
    browser.filtered = [entry];
    browser.selectedKey = entry.key;

    const opening = browser.openAsNewSitch();
    expect(window.open).toHaveBeenCalledWith("", "_blank");
    expect(getFile).toHaveBeenCalledTimes(1);
    expect(putFileHandoff).not.toHaveBeenCalled();

    releaseFile();
    await opening;

    expect(putFileHandoff).toHaveBeenCalledWith([file], {
        source: "track-browser",
        relativePath: entry.relativePath,
    });
    const destination = new URL(popup.location.href);
    expect(destination.origin + destination.pathname).toBe(new URL(originalURL).origin + "/sitrec/");
    expect(destination.searchParams.get("action")).toBe("new");
    expect(destination.searchParams.get("handoff")).toBe("handoff-key");
    expect(window.location.href).toBe(originalURL);
    expect(popup.close).not.toHaveBeenCalled();
});

test("tile metadata uses the same color as its filename", () => {
    const browser = new CTrackBrowser({});
    browser.folderName = "rock_v3";
    const card = browser._makeCard({
        key: "drone", name: "drone_001.all.csv", relativePath: "All/drone_001.all.csv",
        summary: {trackCount: 2, spanM: 1000, durationS: 120,
            truthHorizontalRangeM: 900, truthVerticalRangeM: 0, truthMaxG: 0.247},
    });
    const label = card.children[1];
    const metadata = card.children[2];
    expect(metadata.style.color).toBe(label.style.color);
    expect(label.textContent).toBe("All/drone_001.all.csv");
    expect(metadata.textContent).not.toContain("rock_v3");
    expect(metadata.textContent).not.toContain("tracks");
    expect(metadata.textContent).toContain("Truth h:900m, v:0m, g:0.25");
});

test("g-force sorts valid truth values in either direction and leaves missing values last", () => {
    const browser = new CTrackBrowser({});
    browser.entries = [
        {key: "middle", name: "middle.csv", relativePath: "middle.csv",
            summary: {truthMaxG: 0.25, truthHorizontalRangeM: 100, truthVerticalRangeM: 20}},
        {key: "missing", name: "missing.csv", relativePath: "missing.csv",
            summary: {truthMaxG: null, truthHorizontalRangeM: null, truthVerticalRangeM: null}},
        {key: "high", name: "high.csv", relativePath: "high.csv",
            summary: {truthMaxG: 1.5, truthHorizontalRangeM: 50, truthVerticalRangeM: 300}},
        {key: "low", name: "low.csv", relativePath: "low.csv",
            summary: {truthMaxG: 0.02, truthHorizontalRangeM: 300, truthVerticalRangeM: 10}},
    ];
    browser.sortKey = "g";

    browser.sortAsc = false;
    browser.applyFilterAndSort();
    expect(browser.filtered.map(entry => entry.key)).toEqual(["high", "middle", "low", "missing"]);

    browser.sortAsc = true;
    browser.applyFilterAndSort();
    expect(browser.filtered.map(entry => entry.key)).toEqual(["low", "middle", "high", "missing"]);

    browser.sortKey = "truthHorizontal";
    browser.sortAsc = false;
    browser.applyFilterAndSort();
    expect(browser.filtered.map(entry => entry.key)).toEqual(["low", "middle", "high", "missing"]);

    browser.sortKey = "truthVertical";
    browser.applyFilterAndSort();
    expect(browser.filtered.map(entry => entry.key)).toEqual(["high", "middle", "low", "missing"]);
});
