#!/usr/bin/env node
/**
 * Pre-commit lint gate for Sitrec.
 *
 * Runs Biome's lint (recommended rules + correctness/noUndeclaredVariables,
 * per biome.json) over the subset of files staged for the current commit that
 * live under src/ and have a JS/TS/MJS extension.
 *
 * Why this instead of linting all of src/ on every commit:
 *   - Fast: typical commit touches <10 files; biome runs in well under a second.
 *   - Incremental: the no-undef rule was turned on with ~0 violations across
 *     the tree (2 intentional cycle-skips); we stay at zero by gating each
 *     change that lands, not by re-scanning everything.
 *
 * Bypass (only when truly needed): `git commit --no-verify`.
 */

"use strict";

const { execSync, spawnSync } = require("node:child_process");

function gitStagedFiles() {
    const out = execSync("git diff --cached --name-only --diff-filter=ACMR", {
        encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
}

const staged = gitStagedFiles();
const srcFiles = staged.filter((f) => /^src\/.*\.(js|mjs|ts)$/.test(f));

if (srcFiles.length === 0) {
    // Nothing under src/ — let the commit through.
    process.exit(0);
}

console.log(`[lint-staged] biome on ${srcFiles.length} file(s):`);
for (const f of srcFiles) console.log(`  ${f}`);

// Scoped to correctness/noUndeclaredVariables because that is the only rule
// the codebase has been cleaned up to zero. Biome's broader recommended set
// has plenty of legitimate warnings we have not triaged yet; enabling them
// here would make the gate noisy and teach people to --no-verify past it.
// Widen this list as additional rules get cleaned up across src/.
const res = spawnSync(
    "npx",
    [
        "biome",
        "lint",
        "--only=correctness/noUndeclaredVariables",
        "--no-errors-on-unmatched",
        ...srcFiles,
    ],
    { stdio: "inherit" },
);
process.exit(res.status ?? 1);
