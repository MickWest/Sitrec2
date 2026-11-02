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

    test("the checkbox changes the header in the text, the copy and the download", async () => {
        const writeText = jest.fn(() => Promise.resolve());
        Object.defineProperty(navigator, "clipboard", {value: {writeText}, configurable: true});
        const full = "FILE: falls.ts (10 bytes)\n\nTail: N97826\n\n";
        const plain = "Tail: hidden\n\n";
        showTimingAnalysis("REPORT", "out.txt", undefined, {fileHeader: full, plainHeader: plain});

        const textarea = document.querySelector("textarea");
        const copyButton = buttonNamed("Copy Analysis");
        const checkbox = document.querySelector("input[type=checkbox]");
        expect(checkbox.checked).toBe(true);
        expect(checkbox.parentElement.textContent).toBe("Show Filename and Names");
        expect(textarea.value).toBe(`${full}REPORT`);

        checkbox.checked = false;
        checkbox.onchange();
        expect(textarea.value).toBe(`${plain}REPORT`);
        await copyButton.onclick();
        expect(writeText).toHaveBeenLastCalledWith(`${plain}REPORT`);
        buttonNamed("Download Analysis").onclick();
        expect(await blobText(saveAs.mock.calls.at(-1)[0])).toBe(`${plain}REPORT`);

        checkbox.checked = true;
        checkbox.onchange();
        await copyButton.onclick();
        expect(writeText).toHaveBeenLastCalledWith(`${full}REPORT`);
    });

    test("a file header alone is added or removed by the checkbox", () => {
        showTimingAnalysis("REPORT", undefined, undefined, {fileHeader: "FILE: falls.ts\n\n"});
        const checkbox = document.querySelector("input[type=checkbox]");
        expect(document.querySelector("textarea").value).toBe("FILE: falls.ts\n\nREPORT");
        checkbox.checked = false;
        checkbox.onchange();
        expect(document.querySelector("textarea").value).toBe("REPORT");
    });

    test("has no checkbox when there is no header", () => {
        showTimingAnalysis("REPORT");
        expect(document.querySelector("input[type=checkbox]")).toBeNull();
        expect(document.querySelector("textarea").value).toBe("REPORT");
    });

    test("has no checkbox when there is nothing to hide, and still shows the header", () => {
        showTimingAnalysis("REPORT", undefined, undefined, {fileHeader: "IDS\n\n", plainHeader: "IDS\n\n"});
        expect(document.querySelector("input[type=checkbox]")).toBeNull();
        expect(document.querySelector("textarea").value).toBe("IDS\n\nREPORT");
    });
});
