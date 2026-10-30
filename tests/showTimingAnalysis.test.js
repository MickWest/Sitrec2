/**
 * @jest-environment jsdom
 */
jest.mock("file-saver", () => ({saveAs: jest.fn()}));
import {saveAs} from "file-saver";
import {showTimingAnalysis} from "../src/showTimingAnalysis";

const blobText = (blob) => new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(blob);
});
const buttonNamed = (name) => [...document.querySelectorAll("button")].find(b => b.textContent === name);

describe("showTimingAnalysis", () => {
    afterEach(() => { document.body.innerHTML = ""; });

    test("Show Filename adds the file line to the text, the copy and the download", async () => {
        const writeText = jest.fn(() => Promise.resolve());
        Object.defineProperty(navigator, "clipboard", {value: {writeText}, configurable: true});
        showTimingAnalysis("REPORT", "out.txt", undefined, {fileHeader: "FILE: falls.ts (10 bytes)\n\n"});

        const textarea = document.querySelector("textarea");
        const copyButton = buttonNamed("Copy Analysis");
        const checkbox = document.querySelector("input[type=checkbox]");
        expect(checkbox.checked).toBe(true);
        expect(checkbox.parentElement.textContent).toBe("Show Filename");
        expect(textarea.value).toBe("FILE: falls.ts (10 bytes)\n\nREPORT");

        checkbox.checked = false;
        checkbox.onchange();
        expect(textarea.value).toBe("REPORT");
        await copyButton.onclick();
        expect(writeText).toHaveBeenLastCalledWith("REPORT");
        buttonNamed("Download Analysis").onclick();
        expect(await blobText(saveAs.mock.calls.at(-1)[0])).toBe("REPORT");

        checkbox.checked = true;
        checkbox.onchange();
        await copyButton.onclick();
        expect(writeText).toHaveBeenLastCalledWith("FILE: falls.ts (10 bytes)\n\nREPORT");
    });

    test("has no checkbox when there is no file line", () => {
        showTimingAnalysis("REPORT");
        expect(document.querySelector("input[type=checkbox]")).toBeNull();
        expect(document.querySelector("textarea").value).toBe("REPORT");
    });
});
