/** @jest-environment jsdom */
import {openBotBenchDialog} from "../../src/analysis/BotBenchUI";
import * as handoff from "../../src/TraverseHandoff";

let state;
beforeEach(() => {
    jest.spyOn(handoff, "openHandoffWindow").mockImplementation(() => {});
    state = openBotBenchDialog();
});
afterEach(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}));
    state.closeButton.onclick();
    jest.restoreAllMocks();
});

function addEntry(overrides = {}) {
    const file = new File(["source track"], "example.all.csv", {type: "text/csv"});
    const entry = {name: file.name, relativePath: `All/${file.name}`, status: "done",
        getFile: jest.fn(async () => file), results: null, ...overrides};
    entry.rowIndex = state.entries.length;
    state.entries.push(entry);
    state.rowView.render();
    return {entry, file, link: state.rowView.rowFor(entry.rowIndex).link};
}

async function choose(label) {
    const button = [...document.querySelectorAll("button")]
        .find(b => b.firstElementChild?.textContent === label);
    expect(button).toBeDefined();
    button.click();
    // The choice resolves from this click, before the handoff reads any files.
    await Promise.resolve();
    return handoff.openHandoffWindow.mock.calls[0]?.[0];
}

test("filename offers both actions and Cancel opens nothing", async () => {
    const {link, entry} = addEntry();
    link.click();
    const labels = [...document.querySelectorAll("button")]
        .map(b => b.firstElementChild?.textContent).filter(Boolean);
    expect(labels).toEqual(["Open solutions in Sitrec", "Open file in Sitrec", "Cancel"]);
    expect(handoff.openHandoffWindow).not.toHaveBeenCalled();
    await choose("Cancel");
    expect(handoff.openHandoffWindow).not.toHaveBeenCalled();
    expect(entry.getFile).not.toHaveBeenCalled();
});

test("file-only hands over the source without reading released solutions", async () => {
    const {entry, file, link} = addEntry();
    const rebuilding = jest.fn();
    Object.defineProperty(entry, "rebuilding", {get: rebuilding});
    link.click();
    const opening = await choose("Open file in Sitrec");
    expect(entry.getFile).not.toHaveBeenCalled();
    const payload = await opening.buildFiles();
    expect(rebuilding).not.toHaveBeenCalled();
    expect(payload.files).toEqual([file]);
    expect(payload.meta).toMatchObject({source: "botbench", relativePath: entry.relativePath,
        cameraOnScenarioTrack: true});
    expect(payload.meta.candidateTrackNames).toBeUndefined();
    expect(payload.meta.lookCameraFraming).toBeUndefined();
    const url = new URL(opening.urlFor("test-key"));
    expect(url.searchParams.get("action")).toBe("new");
    expect(url.searchParams.get("handoff")).toBe("test-key");
    opening.onDone();
    expect(entry.busy).toBeNull();
});

test("solutions retain the existing candidate handoff and the originally clicked entry", async () => {
    const results = {dataset: {n: 12}};
    const {entry, file, link} = addEntry({results});
    const frame = {toLLA: jest.fn(), altitudeIsHAE: false, startMs: 1234};
    const candidates = [{name: "c_fixedPoint", text: "candidate CSV", hypothesis: "Fixed point", tier: "consistent"}];
    jest.spyOn(handoff, "botHandoffFrame").mockReturnValue(frame);
    jest.spyOn(handoff, "handoffCandidateCSVs").mockReturnValue(candidates);
    jest.spyOn(handoff, "lookCameraFraming").mockReturnValue({closestRangeM: 500});
    link.click();
    // Virtual table rows may display another file while the choice is open.
    state.rowView.rowFor(0).item = {name: "different.csv"};
    const opening = await choose("Open solutions in Sitrec");
    const payload = await opening.buildFiles();
    expect(payload.files[0]).toBe(file);
    expect(payload.files.map(f => f.name)).toEqual([file.name, "c_fixedPoint.csv"]);
    expect(handoff.handoffCandidateCSVs).toHaveBeenCalledWith(results, frame);
    expect(payload.meta.candidateTrackNames).toEqual(["c_fixedPoint"]);
    expect(payload.meta.lookCameraFraming).toEqual({closestRangeM: 500});
    expect(payload.meta.relativePath).toBe(entry.relativePath);
    opening.onDone();
});
