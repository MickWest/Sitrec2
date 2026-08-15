// Run Jest with the traverse-fit suites either isolated or excluded.
//
//   node scripts/jestFits.mjs --only    just the fit suites (~146s wall, ~349s of work)
//   node scripts/jestFits.mjs --skip    everything else (~121s wall)
//
// A script rather than two literal jest invocations in package.json, so the file list in
// fitTests.js stays the single source of truth. Writing the pattern out by hand in package.json
// would let the two drift, and the drift is silent: a suite named in neither command runs
// nowhere while both still exit 0.
//
// NOTE on --testPathIgnorePatterns: passing it on the CLI REPLACES the config's list rather
// than adding to it, so every pattern the config relies on has to be passed through as well.
// They are read straight out of package.json rather than restated here, because restating them
// is how they drift.
//
// Do not be tempted to drop them on the theory that the positional "tests/" already restricts
// collection — it does not. The positional is a REGEX matched against the whole path, so
// dist-standalone/tests/ matches it happily: omitting the config ignores collected 285 suites
// instead of 192, pulling in 94 stale copies out of the build output and reporting 97 failures.

import {spawnSync} from "child_process";
import {readFileSync} from "fs";
import {fileURLToPath} from "url";
import path from "path";
import fitTests from "./fitTests.js";

const {FIT_TESTS, FIT_TEST_IGNORE_PATTERN} = fitTests;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
// <rootDir> is a Jest config token that is NOT expanded in CLI arguments, so resolve it here.
const rootRx = repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const configIgnores = (pkg.jest?.testPathIgnorePatterns ?? [])
    .map((p) => p.replace("<rootDir>", rootRx));

const mode = process.argv[2];
const passThrough = process.argv.slice(3);

let args;
if (mode === "--only") {
    args = ["jest", "--runTestsByPath", ...FIT_TESTS, ...passThrough];
} else if (mode === "--skip") {
    args = ["jest", "tests/",
        "--testPathIgnorePatterns", "/node_modules/", ...configIgnores, FIT_TEST_IGNORE_PATTERN,
        ...passThrough];
} else {
    console.error("usage: node scripts/jestFits.mjs --only|--skip [extra jest args]");
    process.exit(2);
}

const r = spawnSync("npx", args, {stdio: "inherit", shell: process.platform === "win32"});
process.exit(r.status ?? 1);
