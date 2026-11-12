import fs from "fs";
import path from "path";
import {parseJavascriptObject} from "../src/Serialize";

// data/custom/SitCustom.js is not loaded as a JS module. The server (getsitches.php) or the
// serverless fetch sends its raw text, and RegisterSitches reads that text with
// parseJavascriptObject, an ad hoc parser. Valid JavaScript that this parser cannot read
// (for example strings joined with +) passes every JS syntax check and the build, but then
// the custom sitch - the default sitch - does not load at all.
test("data/custom/SitCustom.js parses as a text sitch", () => {
    const text = fs.readFileSync(path.resolve(__dirname, "../data/custom/SitCustom.js"), "utf8");
    const obj = parseJavascriptObject(text);
    expect(obj).toBeTruthy();
    expect(obj.name).toBe("custom");
});
