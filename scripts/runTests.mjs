// Run the SitrecBridge suite and the Jest suite — ALWAYS BOTH — and report both.
//
//   node scripts/runTests.mjs --fits     bridge + every Jest suite under tests/  (npm test)
//   node scripts/runTests.mjs --nofits   bridge + Jest minus the traverse fits   (npm run test-nofits)
//
// This replaces `npm --prefix tools/SitrecBridge test && npx jest ...` in package.json. Running
// the bridge suites first, under their own `node --test` runner, is deliberate (see the 2.110.3
// entry in docs/WhatsNew-Details.md) — the `&&` joining them was not.
//
// Why the short-circuit had to go: the bridge suite spawns a real broker that binds a loopback
// TCP port, which a sandboxed shell refuses outright with `listen EPERM`, so ~10 of its 35 tests
// fail on completely clean code. `&&` then meant the ~4400 Jest tests never ran at all — and the
// run still ended in what looks like a finished test report ("1..35 / # fail 10"), so the only
// tell that the entire real suite had been skipped was the test count. A test command must never
// be able to report a smaller failure while silently declining to run the larger part.
//
// Both phases now always run. The exit status is non-zero if EITHER failed, so this is strictly
// more sensitive than the `&&` it replaces: nothing that used to fail the command now passes it.

import {spawnSync} from "child_process";
import {fileURLToPath} from "url";
import path from "path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// npm and npx are shell scripts on Windows, so they need a shell there; jest is reached through
// them, and `node` never needs one.
const mode = process.argv[2];
const passThrough = process.argv.slice(3);

let jestPhase;
if (mode === "--fits") {
    jestPhase = {name: "Jest — all suites", cmd: "npx", args: ["jest", "tests/", ...passThrough]};
} else if (mode === "--nofits") {
    jestPhase = {
        name: "Jest — traverse-fit suites excluded",
        cmd: "node",
        args: [path.join(repoRoot, "scripts", "jestFits.mjs"), "--skip", ...passThrough],
    };
} else {
    console.error("usage: node scripts/runTests.mjs --fits|--nofits [extra jest args]");
    process.exit(2);
}

const phases = [
    {name: "SitrecBridge — node:test", cmd: "npm", args: ["--prefix", "tools/SitrecBridge", "test"]},
    jestPhase,
];

const results = [];
for (const phase of phases) {
    console.log(`\n=== ${phase.name} ===\n`);
    const run = spawnSync(phase.cmd, phase.args, {
        stdio: "inherit",
        cwd: repoRoot,
        shell: process.platform === "win32" && phase.cmd !== "node",
    });
    results.push({name: phase.name, status: run.status ?? 1});
}

console.log("\n=== Test summary ===");
for (const result of results) {
    console.log(`  ${result.status === 0 ? "PASS" : "FAIL"}  ${result.name}`);
}

const failures = results.filter((result) => result.status !== 0);
if (failures.length > 0) {
    console.log(`\n${failures.length} of ${results.length} phases failed.`);
    if (failures.some((failure) => failure.name.startsWith("SitrecBridge"))) {
        console.log(
            "\nIf every SitrecBridge failure reads `listen EPERM: operation not permitted`, that is\n" +
            "a sandboxed shell refusing a loopback port, not a code regression. Re-run with the\n" +
            "sandbox disabled. The Jest result above is unaffected either way.");
    }
}
process.exit(failures.length > 0 ? 1 : 0);
