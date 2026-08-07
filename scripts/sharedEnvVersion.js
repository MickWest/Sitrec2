#!/usr/bin/env node
/**
 * shared.env.example version stamping and freshness gate.
 *
 * config/shared.env.example carries a SHARED_ENV_VERSION stamp (date-based,
 * e.g. 2026-08-06, with a .2 / .3 suffix for multiple bumps on the same day).
 * Two consumers:
 *
 *   1. .githooks/pre-commit runs `--bump-staged`: when a commit changes the
 *      example's content (beyond the version line itself), the stamp is bumped
 *      to today's date, restaged, and the committer's own config/shared.env
 *      version line is synced (they authored the change, so their file is
 *      presumed current).
 *
 *   2. webpack.common.js calls checkOrExit() at config-load time, so EVERY
 *      build variant (dev, prod, docker, standalone, serverless) refuses to
 *      build when config/shared.env carries an older version than the example.
 *      The failure message shows what changed since the user's version (via
 *      git history when available, GitHub links otherwise) and exactly how to
 *      get current again.
 *
 * Fresh installs are unaffected: CI, the Dockerfile, and install scripts all
 * copy shared.env.example to shared.env, inheriting the current stamp.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Overridable so tests can point --bump-staged / --check at a scratch repo.
const ROOT = process.env.SHARED_ENV_ROOT || path.resolve(__dirname, "..");
const EXAMPLE_REL = "config/shared.env.example";
const ENV_REL = "config/shared.env";

const VERSION_LINE_RE = /^\s*SHARED_ENV_VERSION\s*=\s*"?([^"\s#]*)"?\s*(#.*)?$/;
const VERSION_RE = /^(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?$/;

const GITHUB_HISTORY_URL =
    "https://github.com/MickWest/Sitrec2/commits/main/config/shared.env.example";
const GITHUB_FILE_URL =
    "https://github.com/MickWest/Sitrec2/blob/main/config/shared.env.example";

// ---------------------------------------------------------------------------
// Version parsing / comparison
// ---------------------------------------------------------------------------

function readVersion(content) {
    for (const line of content.split("\n")) {
        const m = line.match(VERSION_LINE_RE);
        if (m) return m[1];
    }
    return null;
}

function parseVersion(v) {
    const m = typeof v === "string" ? v.match(VERSION_RE) : null;
    if (!m) return null;
    return { date: `${m[1]}-${m[2]}-${m[3]}`, seq: m[4] ? parseInt(m[4], 10) : 0 };
}

// -1 / 0 / 1 like a comparator; null (unparseable) sorts oldest so a mangled
// user version reads as out of date rather than silently passing.
function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa && !pb) return 0;
    if (!pa) return -1;
    if (!pb) return 1;
    if (pa.date !== pb.date) return pa.date < pb.date ? -1 : 1;
    return Math.sign(pa.seq - pb.seq);
}

// Next stamp for "today": the bare date, or date.N if the current stamp is
// already from today (multiple example edits committed on the same day).
// A new stamp must always be GREATER than the current one, or installs holding
// the current one would compare as up to date and never see the change. That
// can happen without any clock being wrong: contributors in different time
// zones straddling midnight produce a "today" earlier than the existing stamp,
// so fall back to incrementing the existing stamp rather than going backwards.
function nextVersion(current, today) {
    const cur = parseVersion(current);
    if (!cur) return today;
    if (cur.date === today || compareVersions(today, current) <= 0) {
        return `${cur.date}.${cur.seq + 1}`;
    }
    return today;
}

function todayStamp() {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${mm}-${dd}`;
}

// Replace the existing SHARED_ENV_VERSION line, or prepend one if absent.
function setVersion(content, version) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (VERSION_LINE_RE.test(lines[i])) {
            lines[i] = `SHARED_ENV_VERSION=${version}`;
            return lines.join("\n");
        }
    }
    return (
        `# Version of shared.env.example this file is synced to (see that file)\n` +
        `SHARED_ENV_VERSION=${version}\n\n` +
        content
    );
}

// ---------------------------------------------------------------------------
// Git history for the failure message
// ---------------------------------------------------------------------------

// Argument ARRAY, never a shell string: the version we search for comes out of
// the user's shared.env, and a value like $(...) or `...` would otherwise be
// executed by the shell during an ordinary build.
function git(args, cwd) {
    return execFileSync("git", args, {
        encoding: "utf8",
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
    });
}

// Human-readable account of what changed in shared.env.example since the
// user's version. Best effort: git when available, GitHub links otherwise.
function describeChangesSince(userVersion, cwd) {
    try {
        let base = null;
        if (userVersion) {
            // The oldest commit whose diff mentions the user's stamp is the one
            // that introduced it — everything after it is what they're missing.
            const hashes = git(
                ["log", "-S", `SHARED_ENV_VERSION=${userVersion}`, "--format=%H", "--", EXAMPLE_REL],
                cwd
            ).trim().split("\n").filter(Boolean);
            if (hashes.length) base = hashes[hashes.length - 1];
        }
        if (!base) {
            const parsed = parseVersion(userVersion);
            if (!parsed) throw new Error("no baseline");
            // Stamp never existed in this clone's history (hand-edited?) —
            // fall back to the last commit before the stamp's date.
            base = git(
                ["log", "-1", `--before=${parsed.date} 00:00`, "--format=%H", "--", EXAMPLE_REL],
                cwd
            ).trim();
            if (!base) throw new Error("no baseline");
        }

        const log = git(
            ["log", "--date=short", "--format=  %h %ad  %s", `${base}..HEAD`, "--", EXAMPLE_REL],
            cwd
        ).trimEnd();
        if (!log) throw new Error("no commits in range");

        let diff = git(["diff", `${base}..HEAD`, "--", EXAMPLE_REL], cwd).trimEnd();
        const diffLines = diff.split("\n");
        const MAX_DIFF_LINES = 120;
        if (diffLines.length > MAX_DIFF_LINES) {
            diff =
                diffLines.slice(0, MAX_DIFF_LINES).join("\n") +
                `\n  ... (${diffLines.length - MAX_DIFF_LINES} more lines — run:` +
                ` git diff ${base.slice(0, 10)}..HEAD -- ${EXAMPLE_REL})`;
        }
        return `Commits touching ${EXAMPLE_REL} since your version:\n${log}\n\n${diff}`;
    } catch (e) {
        return (
            `(Could not derive the changes from git here.)\n` +
            `See what changed in the example file on GitHub:\n` +
            `  history: ${GITHUB_HISTORY_URL}\n` +
            `  current: ${GITHUB_FILE_URL}\n` +
            `Or compare your file locally:  diff ${ENV_REL} ${EXAMPLE_REL}`
        );
    }
}

// ---------------------------------------------------------------------------
// Build-time freshness check
// ---------------------------------------------------------------------------

// Returns { ok: true } or { ok: false, message } — pure so tests can drive it
// with temp files. `cwd` is only used for the git-history part of the message.
function check({ envPath, examplePath, cwd } = {}) {
    envPath = envPath || path.join(ROOT, ENV_REL);
    examplePath = examplePath || path.join(ROOT, EXAMPLE_REL);
    cwd = cwd || ROOT;

    // Missing files are someone else's problem (webpack already throws if
    // shared.env is absent; an example-less tree predates this mechanism).
    if (!fs.existsSync(envPath) || !fs.existsSync(examplePath)) return { ok: true };

    const exampleVersion = readVersion(fs.readFileSync(examplePath, "utf8"));
    if (!parseVersion(exampleVersion)) {
        // No stamp at all = a branch predating this mechanism; nothing to compare.
        if (exampleVersion === null) return { ok: true };
        // A stamp that is present but unparseable (bad merge resolution, hand
        // edit, hook bypassed) would silently disable the gate for every build,
        // so fail loudly instead of quietly letting stale configs through.
        return {
            ok: false,
            message:
                `\n[shared-env] ${EXAMPLE_REL} has a malformed SHARED_ENV_VERSION ` +
                `("${exampleVersion}").\n` +
                `[shared-env] Expected YYYY-MM-DD (optionally .N). Fix the stamp in ` +
                `${EXAMPLE_REL} — until it parses, builds cannot tell whether your ` +
                `${ENV_REL} is current.\n`,
        };
    }

    const envVersion = readVersion(fs.readFileSync(envPath, "utf8"));
    // Equal or NEWER passes — switching to an older branch must not block builds.
    if (envVersion && compareVersions(envVersion, exampleVersion) >= 0) return { ok: true };

    const yours = envVersion
        ? `SHARED_ENV_VERSION=${envVersion}` +
          (parseVersion(envVersion) ? "" : "  (malformed — expected YYYY-MM-DD)")
        : "(none — your file predates version stamping)";

    const message = `
============================================================================
 BUILD STOPPED: your ${ENV_REL} is out of date
============================================================================

 ${EXAMPLE_REL} has changed since your ${ENV_REL} was last brought
 up to date. New or changed settings may affect this install.

     your    ${ENV_REL}          ${yours}
     current ${EXAMPLE_REL}  SHARED_ENV_VERSION=${exampleVersion}

${indent(describeChangesSince(envVersion, cwd), " ")}

 What to do:

   1. Review the changes above and merge anything relevant into your
      ${ENV_REL} (new settings usually have safe defaults, but check
      anything that affects your deployment).

   2. Mark your file current by setting its version line to:

          SHARED_ENV_VERSION=${exampleVersion}

      (add that line near the top if your file doesn't have one)

   3. Re-run the build.
============================================================================
`;
    return { ok: false, message };
}

function indent(text, pad) {
    return text.split("\n").map((l) => (l ? pad + l : l)).join("\n");
}

// Called from webpack.common.js — prints instructions and stops the build.
function checkOrExit() {
    const result = check();
    if (!result.ok) {
        console.error(result.message);
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// Commit-time stamping (pre-commit hook)
// ---------------------------------------------------------------------------

// Exit codes for --bump-staged, consumed by .githooks/pre-commit:
//   0 = bumped (hook must `git add` the example)
//   3 = nothing to do (no content change, or a valid manual bump)
//   1 = stamping could not be done safely; the commit must be blocked
//       (this script has already printed why)
const EXIT_BUMPED = 0;
const EXIT_NO_BUMP = 3;
const EXIT_FAIL = 1;

function stripVersionLines(content) {
    return content
        .split("\n")
        .filter((l) => !VERSION_LINE_RE.test(l))
        .join("\n");
}

// Keep the committer's own (gitignored) shared.env stamp current so their next
// build doesn't trip the gate they just created — they authored the change.
function syncLocalEnv(newVersion) {
    const envPath = path.join(ROOT, ENV_REL);
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, "utf8");
    if (readVersion(content) === newVersion) return;
    fs.writeFileSync(envPath, setVersion(content, newVersion));
    console.log(
        `[shared-env] synced your local ${ENV_REL} to SHARED_ENV_VERSION=${newVersion}\n` +
        `[shared-env] (it is gitignored; double-check it actually reflects the example change)`
    );
}

function bumpStaged(today) {
    let staged;
    try {
        staged = git(["show", `:${EXAMPLE_REL}`], ROOT);
    } catch (e) {
        // Not actually in the index — nothing for us to do.
        return EXIT_NO_BUMP;
    }
    let head = "";
    try {
        head = git(["show", `HEAD:${EXAMPLE_REL}`], ROOT);
    } catch (e) {
        // New file (no HEAD version) — treat as changed from empty.
    }

    const stagedVersion = readVersion(staged);

    if (stripVersionLines(staged) === stripVersionLines(head)) {
        // Only the version line (or nothing) changed — e.g. a manual bump.
        if (stagedVersion && stagedVersion !== readVersion(head)) syncLocalEnv(stagedVersion);
        return EXIT_NO_BUMP;
    }

    const headVersion = readVersion(head);

    if (stagedVersion !== headVersion) {
        // Content changed AND the committer touched the stamp themselves. Accept
        // it only if it is a real forward bump — a deleted, mistyped, or
        // backwards stamp would ship the change with a version that installs
        // either can't compare or already consider current, silently defeating
        // the whole gate.
        if (!parseVersion(stagedVersion) || compareVersions(stagedVersion, headVersion) <= 0) {
            console.error(
                `[shared-env] ${EXAMPLE_REL} changed, but its SHARED_ENV_VERSION is not a forward bump.\n` +
                `[shared-env]   staged: ${stagedVersion === null ? "(missing)" : stagedVersion}\n` +
                `[shared-env]   HEAD:   ${headVersion === null ? "(none)" : headVersion}\n` +
                `[shared-env] Set it to ${nextVersion(headVersion, today)} (or remove your manual edit\n` +
                `[shared-env] and let the hook stamp it), then commit again.`
            );
            return EXIT_FAIL;
        }
        console.log(`[shared-env] ${EXAMPLE_REL} already bumped to ${stagedVersion}`);
        syncLocalEnv(stagedVersion);
        return EXIT_NO_BUMP;
    }

    // We rewrite the working-tree file from the STAGED content and the hook
    // restages it — so refuse if the working tree has extra unstaged edits
    // that a blind write would destroy. Failing (rather than warning and
    // continuing) is deliberate: letting the commit through would record
    // changed settings under the old stamp, and no install would ever be told.
    const examplePath = path.join(ROOT, EXAMPLE_REL);
    const working = fs.readFileSync(examplePath, "utf8");
    if (working !== staged) {
        console.error(
            `[shared-env] ${EXAMPLE_REL} has changes staged AND further unstaged edits,\n` +
            `[shared-env] so the version stamp cannot be applied safely.\n` +
            `[shared-env] Either stage the rest of the file (git add ${EXAMPLE_REL}),\n` +
            `[shared-env] or set SHARED_ENV_VERSION=${nextVersion(stagedVersion, today)} yourself and stage that.`
        );
        return EXIT_FAIL;
    }

    const newVersion = nextVersion(stagedVersion, today);
    fs.writeFileSync(examplePath, setVersion(staged, newVersion));
    console.log(`[shared-env] ${EXAMPLE_REL} changed — stamped SHARED_ENV_VERSION=${newVersion}`);
    syncLocalEnv(newVersion);
    return EXIT_BUMPED;
}

// ---------------------------------------------------------------------------

module.exports = {
    readVersion,
    parseVersion,
    compareVersions,
    nextVersion,
    setVersion,
    stripVersionLines,
    check,
    checkOrExit,
};

if (require.main === module) {
    const mode = process.argv[2];
    if (mode === "--bump-staged") {
        process.exit(bumpStaged(todayStamp()));
    } else if (mode === "--check") {
        checkOrExit();
        console.log("[shared-env] config/shared.env is up to date");
    } else {
        console.error("usage: sharedEnvVersion.js --check | --bump-staged");
        process.exit(1);
    }
}
