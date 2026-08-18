import test from "node:test";
import assert from "node:assert/strict";
import {chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";

const RUN_SH = fileURLToPath(new URL("../run.sh", import.meta.url));

function makeLauncherFixture(t) {
    const dir = mkdtempSync(join(tmpdir(), "sitrec-bridge-launcher-"));
    t.after(() => rmSync(dir, {recursive: true, force: true}));

    const launcher = join(dir, "run.sh");
    copyFileSync(RUN_SH, launcher);
    chmodSync(launcher, 0o755);

    return {dir, launcher};
}

test("run.sh starts the bundled .mjs server in a distribution", {
    skip: process.platform === "win32",
}, (t) => {
    const {dir, launcher} = makeLauncherFixture(t);
    writeFileSync(join(dir, "mcp-server.mjs"), "process.stdout.write('distribution');\n");
    writeFileSync(join(dir, "mcp-server.js"), "process.stdout.write('source');\n");

    const result = spawnSync(launcher, {encoding: "utf8"});

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "distribution");
});

test("run.sh falls back to the .js server in the source tree", {
    skip: process.platform === "win32",
}, (t) => {
    const {dir, launcher} = makeLauncherFixture(t);
    writeFileSync(join(dir, "mcp-server.js"), "process.stdout.write('source');\n");

    const result = spawnSync(launcher, {encoding: "utf8"});

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "source");
});
