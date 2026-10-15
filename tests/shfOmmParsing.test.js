import {execFileSync} from "child_process";
import path from "path";

// The flare tool (tools/shf/) is served as raw ES modules that use top-level await,
// which Jest cannot load, so its catalogue-parsing suite runs as its own Node process.
// This puts that suite, including the full-catalogue scale cases, into npm test.
test("the flare tool's OMM and TLE parsing suite passes", () => {
    const shf = path.resolve(__dirname, "..", "tools", "shf");
    const out = execFileSync(process.execPath, [path.join(shf, "tools", "test-omm.mjs")], {cwd: shf, encoding: "utf8"});
    expect(out).toContain("ALL PASS");
}, 60000);
