#!/usr/bin/env node

/**
 * Build a publishable image the way the release workflow does, then review it.
 *
 *   node scripts/auditReleaseImage.mjs [options]
 *
 * The release workflow builds its bundle from config/shared.env.example, so a published
 * image carries only the shipped placeholders. A working checkout builds from the
 * developer's own config/shared.env, so its images carry real credentials on purpose —
 * which is correct for a local or site image and would be a disclosure in a published one.
 *
 * The two paths differ only in that one input, and nothing local reproduces the release
 * path, so a mistake in it — a credential that reaches the published artifact — would first
 * be visible in a registry. This script closes that gap: it reproduces the release build
 * locally and runs the container review over the result with the strict profile, so the
 * check that matters can be run before a tag is pushed rather than after.
 *
 * It never touches the checkout's own configuration or its dist/. The build is redirected
 * with SITREC_SHARED_ENV and SITREC_PROD_PATH (see scripts/buildTarget.js), which exist so
 * one checkout can build for several deployments; here they point at the shipped example
 * and at a scratch directory.
 *
 * Options:
 *   --tag=<ref>      image tag to build (default: sitrec-release-audit:local)
 *   --out=<dir>      report output directory (default: dist-audit/release)
 *   --skip-build     reuse an existing dist-release-audit/ instead of rebuilding the bundle
 *   --skip-image     reuse an existing image instead of rebuilding it
 *   --fail-on=<sev>  severity that makes this exit non-zero (default: critical)
 *   --keep           keep the scratch bundle directory (default: kept; use --clean to remove)
 *   --clean          remove the scratch bundle directory when finished
 */

import fs from "fs";
import path from "path";
import {spawnSync} from "child_process";
import {fileURLToPath} from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// Fixed, repo-local and never taken from an argument. webpack's production config cleans
// its output directory, so a mistyped path here would delete whatever it named.
const SCRATCH_DIST_NAME = "dist-release-audit";
const SCRATCH_DIST = path.join(PROJECT_ROOT, SCRATCH_DIST_NAME);
const EXAMPLE_ENV = "config/shared.env.example";

function parseArgs(argv) {
    const opts = {
        tag: "sitrec-release-audit:local",
        out: path.join(PROJECT_ROOT, "dist-audit", "release"),
        skipBuild: false,
        skipImage: false,
        failOn: "critical",
        clean: false,
    };
    for (const arg of argv) {
        const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
        if (!m) throw new Error(`unrecognised argument: ${arg}`);
        const [, key, value] = m;
        switch (key) {
            case "tag": opts.tag = value; break;
            case "out": opts.out = path.resolve(value); break;
            case "skip-build": opts.skipBuild = true; break;
            case "skip-image": opts.skipImage = true; break;
            case "fail-on": opts.failOn = value; break;
            case "keep": opts.clean = false; break;
            case "clean": opts.clean = true; break;
            default: throw new Error(`unrecognised option: --${key}`);
        }
    }
    return opts;
}

function step(n, total, text) {
    console.log(`\n[${n}/${total}] ${text}`);
}

function runInherit(cmd, args, env) {
    const r = spawnSync(cmd, args, {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
        env: {...process.env, ...env},
    });
    if (r.error) throw new Error(`${cmd} could not be started: ${r.error.message}`);
    return r.status ?? 1;
}

function which(cmd) {
    return spawnSync("command", ["-v", cmd], {encoding: "utf8", shell: true}).status === 0;
}

function main(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (err) {
        console.error(`auditReleaseImage: ${err.message}`);
        process.exit(2);
    }

    const engine = which("docker") ? "docker" : which("podman") ? "podman" : null;
    if (!engine) {
        console.error("auditReleaseImage: neither docker nor podman is on PATH");
        process.exit(2);
    }
    if (!fs.existsSync(path.join(PROJECT_ROOT, EXAMPLE_ENV))) {
        console.error(`auditReleaseImage: ${EXAMPLE_ENV} is missing; it is the input that makes this a release-shaped build`);
        process.exit(2);
    }

    const total = 3;

    // --- 1. the bundle, built from the shipped example configuration ---------
    if (opts.skipBuild) {
        if (!fs.existsSync(SCRATCH_DIST)) {
            console.error(`auditReleaseImage: --skip-build given but ${SCRATCH_DIST_NAME}/ does not exist`);
            process.exit(2);
        }
        step(1, total, `Reusing existing ${SCRATCH_DIST_NAME}/`);
    } else {
        step(1, total, `Building the production bundle from ${EXAMPLE_ENV} into ${SCRATCH_DIST_NAME}/`);
        console.log("        (your config/ and dist/ are not touched)");
        const status = runInherit("npx", ["webpack", "--config", "webpack.prod.js"], {
            SITREC_SHARED_ENV: EXAMPLE_ENV,
            SITREC_PROD_PATH: SCRATCH_DIST,
            DOCKER_BUILD: "true",
        });
        if (status !== 0) {
            console.error("\nauditReleaseImage: the bundle build failed");
            process.exit(status);
        }
    }

    // A cheap, direct check of the one property this whole script exists to verify, made
    // before the much slower image build so a mistake is caught in seconds rather than
    // minutes. The container review repeats it properly against the built image.
    // A value counts as a placeholder only on an EXACT match, and the key is trimmed the
    // way sitrecServer/injectEnv.php trims it. Prefix matching would wave through a real
    // credential that happened to begin with one of these words, and skipping a padded key
    // would miss a setting the application actually reads. Same rule as the container
    // review's in-image probe, deliberately.
    const PLACEHOLDERS = new Set([
        "EXAMPLEKEY", "EXAMPLE_KEY", "EXAMPLE", "CHANGEME", "CHANGE_ME", "PLACEHOLDER",
        "TODO", "NONE", "NULL", "UNSET", "YOUR_KEY_HERE", "YOUR_API_KEY", "YOURKEYHERE",
    ]);
    const isPlaceholder = (v) => PLACEHOLDERS.has(v.toUpperCase()) || /^<.*>$/.test(v);

    const envPhp = path.join(SCRATCH_DIST, "shared.env.php");
    if (fs.existsSync(envPhp)) {
        const real = fs.readFileSync(envPhp, "utf8")
            .split("\n")
            .map((l) => /^\s*([A-Za-z0-9_]+)\s*=(.*)$/.exec(l))
            .filter(Boolean)
            .map(([, k, v]) => [null, k.trim(), v.trim().replace(/^["']|["']$/g, "")])
            .filter(([, k, v]) => /(^|_)(TOKEN|SECRET|PASSWORD|ACCESS_KEY|API_KEY|API|KEY)(_|$)/i.test(k)
                && v !== ""
                && !isPlaceholder(v));
        if (real.length) {
            console.error(`\nauditReleaseImage: ${SCRATCH_DIST_NAME}/shared.env.php holds ${real.length} non-placeholder credential(s): ${real.map(([, k]) => k).join(", ")}`);
            console.error("auditReleaseImage: the build did not read the example configuration; stopping before an image is made.");
            process.exit(1);
        }
        console.log(`        shared.env.php: placeholders only`);
    }

    // --- 2. the image -------------------------------------------------------
    if (opts.skipImage) {
        step(2, total, `Reusing existing image ${opts.tag}`);
    } else {
        step(2, total, `Building ${opts.tag} from Dockerfile.release`);
        const status = runInherit(engine, [
            "build",
            "-f", "Dockerfile.release",
            "--build-arg", `DIST_DIR=${SCRATCH_DIST_NAME}`,
            "-t", opts.tag,
            ".",
        ]);
        if (status !== 0) {
            console.error("\nauditReleaseImage: the image build failed");
            process.exit(status);
        }
    }

    // --- 3. the review ------------------------------------------------------
    step(3, total, `Reviewing ${opts.tag} as a published image`);
    const status = runInherit(process.execPath, [
        path.join(__dirname, "auditContainerImage.mjs"),
        `--image=${opts.tag}`,
        "--profile=published",
        `--out=${opts.out}`,
        `--fail-on=${opts.failOn}`,
        `--engine=${engine}`,
    ]);

    if (opts.clean && !opts.skipBuild) {
        fs.rmSync(SCRATCH_DIST, {recursive: true, force: true});
        console.log(`\nRemoved ${SCRATCH_DIST_NAME}/`);
    }

    if (status !== 0) {
        console.error(`\nauditReleaseImage: the review found something at or above ${opts.failOn}. Do not push this image.`);
        process.exit(status);
    }
    console.log(`\nauditReleaseImage: no finding at or above ${opts.failOn}. A release built this way carries no credential.`);
}

main(process.argv.slice(2));
