// Decide whether a ship needs to run the expensive traverse-fit suites.
//
// Usage:  node scripts/needFitTests.mjs [baseRef]
//
// Considers everything that would go out in this release: the commits since baseRef (default:
// the latest version tag, matching what /ship reports as unreleased) PLUS the current working
// tree, staged and unstaged. A file that is only in the working tree still ships, so leaving it
// out would let an uncommitted change to LOSFitting.js skip the suites that cover it.
//
// Exit code 0 = run them, 1 = safe to skip. Prints the reason either way, so a ship log records
// WHY the slow suites were skipped rather than leaving it to be inferred.
//
// Fails OPEN: if the git plumbing does not answer (no tags yet, detached state, git missing),
// it says run them. The cost of a needless 349 seconds is an annoyance; the cost of silently
// skipping the suites that guard the fitting code is a bad release.

import {execFileSync} from "child_process";
import fitTests from "./fitTests.js";

const {touchesFitCode, FIT_TESTS} = fitTests;

function git(args) {
    // Capture stderr rather than letting it through: on the fail-open path we report the
    // problem ourselves, and git's raw "fatal: ambiguous argument" on top of that reads like
    // the ship broke when it did exactly the safe thing.
    return execFileSync("git", args, {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
}

function decide() {
    let base = process.argv[2];
    if (!base) {
        base = git(["tag", "--sort=-v:refname"]).split("\n")[0].trim();
        if (!base) return {run: true, why: "no version tag found, so the released range is unknown"};
    }

    const committed = git(["diff", "--name-only", `${base}..HEAD`])
        .split("\n").map((s) => s.trim()).filter(Boolean);

    // --porcelain gives "XY path"; renames appear as "R  old -> new", so take the destination.
    const working = git(["status", "--porcelain"])
        .split("\n").map((s) => s.slice(3).trim()).filter(Boolean)
        .map((s) => (s.includes(" -> ") ? s.split(" -> ")[1] : s));

    const changed = [...new Set([...committed, ...working])];
    const hits = changed.filter(touchesFitCode);
    if (hits.length) {
        return {run: true, why: `fit-covered code changed since ${base}: ${hits.slice(0, 6).join(", ")}`
            + (hits.length > 6 ? ` (+${hits.length - 6} more)` : "")};
    }
    return {run: false, why: `no fit-covered code changed since ${base} (${changed.length} files checked)`};
}

let result;
try {
    result = decide();
} catch (e) {
    result = {run: true, why: `could not determine changed files (${e.message.split("\n")[0]}), failing open`};
}

console.log(result.run
    ? `RUN FIT TESTS — ${result.why}`
    : `SKIP FIT TESTS — ${result.why}\n  (${FIT_TESTS.length} suites, ~146s; run them anyway with: npm run test-fits)`);
process.exit(result.run ? 0 : 1);
