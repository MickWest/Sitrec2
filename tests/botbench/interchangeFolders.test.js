/**
 * interchangeFolders.test.js — which subfolders a BOTBench folder walk leaves out.
 *
 * The interchange layout keeps each scenario three times, side by side: Input/
 * (what an analyst is given), Truth/ (the answer key) and All/ (both in one file).
 * A walk that read Input/ as well as All/ analysed every scenario twice: a run over
 * 2,700 scenarios came back as 5,400 rows, and half of them could never be scored.
 */

import {interchangeFoldersToSkip} from "../../src/analysis/BotBenchIngest";

describe("interchangeFoldersToSkip", () => {

    test("a folder holding All, Input and Truth skips Input and Truth", () => {
        expect(interchangeFoldersToSkip(["All", "Input", "Truth", "meta"])).toEqual(new Set(["Input", "Truth"]));
    });

    test("copy exclusion applies only to Input and Truth", () => {
        const skip = interchangeFoldersToSkip(["All", "Input", "Truth", "meta", "SitrecImage", ".botbench-cache"]);
        expect(skip).toEqual(new Set(["Input", "Truth"]));
    });

    test("the names match in any case, and are skipped as they are spelled", () => {
        expect(interchangeFoldersToSkip(["all", "INPUT", "truth"])).toEqual(new Set(["INPUT", "truth"]));
    });

    test("a folder with only some of the three keeps all of them", () => {
        expect(interchangeFoldersToSkip(["Input"]).size).toBe(0);            // a challenge release
        expect(interchangeFoldersToSkip(["Input", "Truth"]).size).toBe(0);   // no All to stand in for them
        expect(interchangeFoldersToSkip(["All", "Input"]).size).toBe(0);
        expect(interchangeFoldersToSkip([]).size).toBe(0);
        expect(interchangeFoldersToSkip(null).size).toBe(0);
    });
});
