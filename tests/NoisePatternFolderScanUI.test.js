/** @jest-environment jsdom */
jest.mock("file-saver", () => ({saveAs: jest.fn()}));
jest.mock("../src/CFileManagerUtils", () => ({isAbortLikeError: e => e.name === "AbortError", supportsDirectoryPicker: () => true}));
jest.mock("../src/DesktopFileSystem", () => ({getDesktopFileSystemBridge: () => null}));
jest.mock("../src/i18n", () => ({t: (key, values) => `${key.split(".").at(-1)}${values ? JSON.stringify(values) : ""}`}));
jest.mock("../src/videoNoisePattern/NoisePatternFolderScan", () => ({createNoisePatternFolderScan: jest.fn(), noisePatternFolderCSV: jest.fn()}));
jest.mock("../src/videoNoisePattern/NoisePatternFile", () => ({normalizeNoisePatternFolderLimit: value => Number(value) || 2}));
jest.mock("../src/videoNoisePattern/NoisePatternHandoff", () => ({createNoisePatternFileLink: jest.fn(() => ({url: "https://example.test/?action=new&handoff=local&npd=1", prepare: jest.fn().mockResolvedValue()}))}));
import {NoisePatternFolderScanDialog} from "../src/videoNoisePattern/NoisePatternFolderScanUI";
import {createNoisePatternFileLink} from "../src/videoNoisePattern/NoisePatternHandoff";

test("highlights and sorts repeats, filters paths, shows reference fraction correctly, and stops on close", () => {
    const dialog = new NoisePatternFolderScanDialog(() => ({}));
    dialog.scan = {stop: jest.fn(), state: {status: "done", folder: "Chosen", folders: [".", "child"], completed: 3, errors: [], rows: [
        {path: "plain.mp4", folder: ".", status: "done", kind: "none"},
        {path: "child/repeat.mp4", folder: "child", status: "done", kind: "repeat", strength: 12, coverage: 6, references: 8},
        {path: "broken.mp4", folder: ".", status: "error", error: "bad file"},
    ]}};
    dialog.directory = {name: "Chosen"};
    dialog.render();
    expect(dialog.limit.value).toBe("2");
    const rows = () => [...dialog.body.querySelectorAll("tr")];
    expect(rows()[0].dataset.path).toBe("child/repeat.mp4");
    expect(rows()[0].dataset.repeat).toBe("true");
    expect(rows()[0].textContent).toContain("6/8 (75.0%)");
    const link = rows()[0].querySelector("a");
    expect(link.target).toBe("_blank");
    expect(link.href).toContain("handoff=local&npd=1");
    link.dispatchEvent(new MouseEvent("click"));
    expect(createNoisePatternFileLink.mock.results[0].value.prepare).toHaveBeenCalled();
    link.dispatchEvent(new MouseEvent("auxclick", {button: 1}));
    link.dispatchEvent(new MouseEvent("contextmenu"));
    expect(createNoisePatternFileLink.mock.results[0].value.prepare).toHaveBeenCalledTimes(3);
    expect(dialog.body.textContent).toContain("error: bad file");
    expect(dialog.resultLabel({status: "done", kind: "cannot", usable: 127, minUsableFrames: 136, held: 195})).toContain('"usable":127,"required":136,"held":195');
    dialog.onlyRepeats.checked = true;
    dialog.render();
    expect(rows()).toHaveLength(1);
    dialog.filter.value = "plain";
    dialog.render();
    expect(rows()).toHaveLength(0);
    dialog.close();
    expect(dialog.scan.stop).toHaveBeenCalled();
    expect(document.body.contains(dialog.overlay)).toBe(false);
});
