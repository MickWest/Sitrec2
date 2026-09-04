#!/usr/bin/env node

/**
 * Container security review for a built Sitrec image.
 *
 *   node scripts/auditContainerImage.mjs [--image=<ref>] [options]
 *
 * Sitrec already audits its BUNDLE: auditBundleSecrets.js proves no credential is in the
 * output, and auditBundleEgress.js proves no unlisted host literal is. Both judge a
 * directory that a web server will serve, so both are correct to permit a file that PHP
 * will never hand out — shared.env.php is the standing example, protected by its "<?php"
 * guard.
 *
 * A container image is a different object under a different threat model. Anyone who can
 * pull the image can read every layer with `docker save`; no web server stands between
 * them and the file, so the "<?php" guard protects nothing. Nothing re-asked the bundle's
 * questions at that layer, and this script is that missing step. It reviews the artifact
 * the operator actually receives.
 *
 * The report is written for someone who must accept the image into a hardened deployment
 * and has never seen this codebase. Every check states what was looked at, what was found,
 * and what the deployment can do about it. Checks are grouped by the control areas of NIST
 * SP 800-190, the public container security guide, so the structure is one a reviewer
 * already knows.
 *
 * Deliberate design points:
 *
 *   - Evidence and judgement are separate. collectEvidence() runs the tools and writes raw
 *     JSON to <out>/evidence/; evaluate() is pure and reads only that. So a report can be
 *     re-rendered from archived evidence months later (--fixture), the checks are testable
 *     without a container engine, and the operator can re-run the same evidence through a
 *     newer version of this script.
 *
 *   - No secret value is ever read out of the container. The in-image probe classifies each
 *     configuration value as empty / placeholder / set and reports only the key name, its
 *     length and that verdict. The report can therefore be handed to anyone.
 *
 *   - A deliberate risk is declared, not silenced. scripts/container-audit-baseline.json
 *     carries the accepted risks, each naming the exact evidence it covers, the reason and
 *     the compensating control — the same shape as the egress allow-list. An accepted risk
 *     still appears in the report, marked ACCEPTED with its reason. Anything the baseline
 *     does not name is a finding, so a NEW world-writable path or a NEW setuid binary
 *     surfaces even though its neighbours are expected.
 *
 * Two kinds of image, two different verdicts on the same evidence
 * ---------------------------------------------------------------
 * A PUBLISHED image is one other people pull: the multi-architecture images the release
 * workflow pushes to the registry. It is built from config/shared.env.example, so every
 * credential in it is the shipped placeholder. A real credential in a published image is
 * a disclosure to everyone who can pull it, and this script treats it as a critical
 * failure that must stop the release.
 *
 * A SITE image is built for one deployment with that deployment's own configuration baked
 * in — the local test image, and the image an operator builds for their own install. Its
 * credentials are there ON PURPOSE. Reporting them as a defect would be wrong and would
 * train the reader to ignore the check. Under --profile=site the same evidence is reported
 * as a handling requirement instead: the image is as sensitive as the credentials it
 * carries, and the report says so and lists what it holds.
 *
 * The default is --profile=published, the strict reading, so an unlabelled run of an
 * unknown image never under-reports.
 *
 * Requires a container engine (docker or podman), trivy and syft on PATH. See
 * docs/dev/Container-Security-Review.md for the offline-database procedure that lets this
 * run inside an isolated network.
 *
 * Options:
 *   --image=<ref>        image to review (default: sitrec:local)
 *   --profile=published|site   how to judge baked credentials (default: published)
 *   --engine=docker|podman   container engine (default: whichever is found)
 *   --out=<dir>          output directory (default: dist-audit)
 *   --dockerfile=<path>  Dockerfile consulted for base-image pinning (default: Dockerfile.release)
 *   --baseline=<path>    accepted-risk declarations (default: scripts/container-audit-baseline.json)
 *   --fixture=<dir>      read evidence from this directory instead of running any tool
 *   --fail-on=<sev>      exit non-zero if a finding at or above this severity is open.
 *                        critical|high|medium|low|none  (default: none — report only)
 *   --json               print the machine-readable report to stdout as well
 *   --quiet              suppress progress output
 */

import fs from "fs";
import path from "path";
import os from "os";
import {spawnSync} from "child_process";
import {fileURLToPath} from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

export const TOOL_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Severity and status vocabulary
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"];
const severityRank = (s) => SEVERITY_ORDER.indexOf(String(s || "info").toLowerCase());

// A status says what the check concluded. Only "fail" and "warn" are open findings;
// "accepted" is a fail that the baseline covers with a written reason.
const STATUS_LABEL = {
    pass: "PASS",
    fail: "FAIL",
    warn: "WARN",
    accepted: "ACCEPTED RISK",
    info: "INFO",
    skip: "SKIPPED",
};

const OPEN_STATUSES = new Set(["fail", "warn"]);

// ---------------------------------------------------------------------------
// Control areas — NIST SP 800-190 (Application Container Security Guide)
// ---------------------------------------------------------------------------

export const AREAS = {
    image: {
        title: "Image contents",
        nist: "SP 800-190 §4.1 — Image risks",
        intro: "What is inside the layers: known-vulnerable packages, and anything secret that a `docker save` would reveal.",
    },
    config: {
        title: "Image configuration",
        nist: "SP 800-190 §4.1.2 — Image configuration defects",
        intro: "What the image asks the runtime for before any policy is applied: the user it runs as, the ports it declares, the tooling it leaves behind.",
    },
    filesystem: {
        title: "Filesystem posture",
        nist: "SP 800-190 §4.1.2, §4.4 — Image and container risks",
        intro: "Permissions and stray material inside the image, measured in a container started with no network.",
    },
    registry: {
        title: "Provenance",
        nist: "SP 800-190 §4.2 — Registry risks",
        intro: "Whether the image can be tied to the source it was built from, and pinned so the same bytes are deployed every time.",
    },
    app: {
        title: "Application surface",
        nist: "SP 800-190 §4.4.2 — Application vulnerabilities",
        intro: "The Sitrec-specific questions: is this the secure build, what server endpoints does it expose, and can the page reach anything outside the deployment.",
    },
    policy: {
        title: "Recommended runtime policy",
        nist: "SP 800-190 §4.3, §4.4 — Orchestrator and container risks",
        intro: "The runtime restrictions this image can accept, derived from the findings above. Informational: these are the operator's to apply.",
    },
};

// ---------------------------------------------------------------------------
// Configuration keys treated as credentials
// ---------------------------------------------------------------------------

// The name rule is the one the builds already use to decide what to blank
// (isSensitiveEnvKey in scripts/serverlessClientEnv.js, shared with the secure build).
// Repeated here rather than imported: that module is CommonJS and reads configuration at
// load time, and a security check should not silently narrow because a build concern
// narrowed. The invariant that matters is a SUPERSET one — this must never call a key
// harmless that a build calls sensitive — and tests/auditContainerImage.test.js proves it
// against the real list, so the two cannot drift apart unnoticed.
const CREDENTIAL_NAME_RE = /(^|_)(TOKEN|SECRET|PASSWORD|ACCESS_KEY|API_KEY|API|KEY)(_|$)/i;

// Names that carry a credential without saying so. A superset of the builds' explicit
// list: this one also covers the server-only credentials, which never reach a bundle and
// so are not the builds' concern, but do reach an image.
const CREDENTIAL_EXPLICIT = new Set([
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "CESIUM_ION_TOKEN",
    "GOOGLE_MAPS_API_KEY",
    "GOOGLE_MAPS_SERVER_API_KEY",
    "MAPBOX_TOKEN",
    "MAPTILER_KEY",
    "ADSBX_RAPIDAPI_KEY",
    "SPACEDATA_USERNAME",
    "SPACEDATA_PASSWORD",
    "OPENAI_API",
    "ANTHROPIC_API",
    "GEMINI_API",
    "GROQ_API",
    "GROK_API",
]);

export function isCredentialKey(key) {
    const k = String(key || "").trim();
    if (!k) return false;
    return CREDENTIAL_EXPLICIT.has(k) || CREDENTIAL_NAME_RE.test(k);
}

// ---------------------------------------------------------------------------
// The in-image probe
// ---------------------------------------------------------------------------

// Runs as `sh -c` inside a container started with no network and no new privileges. It
// emits tab-separated records on stdout and nothing else, so the parser is trivial and
// the whole thing is auditable by anyone reading this file.
//
// Written without a single quote character anywhere, so each line can sit in a
// single-quoted JavaScript string below without escaping. `cut` stands in for `awk` for
// the same reason.
const PROBE_LINES = [
    "W=/var/www/html",
    "",
    "# Who is doing the reading. A probe running as a non-root UID cannot descend into",
    "# root-only directories, so its sweep under-reports; the report says so rather than",
    "# presenting a partial sweep as a complete one.",
    'printf "uid\\t%s\\n" "$(id -u)"',
    "",
    "# Directory mode and owner of the served webroot.",
    'if [ -d "$W" ]; then',
    '  printf "webroot\\t%s\\t%s\\n" "$(ls -ld "$W" | cut -d" " -f1)" "$(ls -ld "$W" | cut -d" " -f3,4 | tr " " ":")"',
    "fi",
    "",
    "# World-writable directories. /proc and /sys are kernel interfaces, not image content.",
    'find / -xdev \\( -path /proc -o -path /sys \\) -prune -o -type d -perm -0002 -print 2>/dev/null | while read -r p; do',
    '  printf "wwdir\\t%s\\t%s\\n" "$(ls -ld "$p" | cut -d" " -f1)" "$p"',
    "done",
    "",
    "# World-writable regular files. Capped: a runaway count is itself the finding.",
    'find / -xdev \\( -path /proc -o -path /sys \\) -prune -o -type f -perm -0002 -print 2>/dev/null | head -500 | while read -r p; do',
    '  printf "wwfile\\t%s\\t%s\\n" "$(ls -l "$p" | cut -d" " -f1)" "$p"',
    "done",
    "",
    "# setuid and setgid binaries: what a process that gains code execution can escalate with.",
    "find / -xdev -type f -perm /6000 -print 2>/dev/null | while read -r p; do",
    '  printf "suid\\t%s\\t%s\\n" "$(ls -l "$p" | cut -d" " -f1)" "$p"',
    "done",
    "",
    "# Build and network tooling left in a runtime image.",
    "for b in gcc g++ cc make ld as pip pip3 apt apt-get dpkg rpm apk yum curl wget git node npm yarn composer python python3 ruby perl nc ncat socat ssh sshd sudo strace gdb; do",
    '  p=$(command -v "$b" 2>/dev/null) && printf "tool\\t%s\\t%s\\n" "$b" "$p"',
    "done",
    "",
    "# Source maps republish the unminified source. None should reach an image.",
    'find "$W" -type f -name "*.map" 2>/dev/null | head -100 | while read -r p; do',
    '  printf "sourcemap\\t%s\\n" "$p"',
    "done",
    "",
    "# Development or private material that should never be packaged.",
    "for n in .git .gitignore private node_modules .env .npmrc .aws .ssh .dockerignore docs/temp tests_regression; do",
    '  [ -e "$W/$n" ] && printf "stray\\t%s\\n" "$W/$n"',
    "done",
    "",
    "# Server endpoints reachable over HTTP.",
    'find "$W/sitrecServer" -maxdepth 1 -type f -name "*.php" 2>/dev/null | while read -r p; do',
    '  printf "endpoint\\t%s\\n" "$(basename "$p")"',
    "done",
    "",
    "# Configuration files baked into the image. For each KEY=value line we report the key,",
    "# the value LENGTH and a classification -- never the value itself, so this report can be",
    "# handed to anyone.",
    "#",
    "# The key and the value are trimmed exactly as sitrecServer/injectEnv.php trims them",
    "# (it does trim($key) and trim($value) before putenv). A padded line like",
    '#   " MAPBOX_TOKEN = live-key "',
    "# is therefore a LIVE setting in the application, and skipping it here because the raw",
    "# key has a space in it would let an active credential pass unreported.",
    "#",
    "# A value counts as a placeholder only on an EXACT match against the shapes the shipped",
    "# example files use, or an <angle-bracketed> stand-in. Prefix matching was wrong: a real",
    "# credential that happens to begin with one of these words would have been waved",
    "# through. Reporting a placeholder as if it were a credential is the harmless error;",
    "# the reverse is the one that matters.",
    "trimws() { printf \"%s\" \"$1\" | sed -e \"s/^[[:space:]][[:space:]]*//\" -e \"s/[[:space:]][[:space:]]*$//\"; }",
    "#",
    "# Readability is checked and reported EXPLICITLY. A file that exists but cannot be read",
    "# yields no key records, and without this an unreadable file would be indistinguishable",
    "# from a file with no credentials in it -- silence reading as cleanliness. That is the",
    "# exact shape of a false pass: a mode-600 credential file in an image whose declared",
    "# user is not root.",
    'for f in "$W/shared.env.php" "$W/.env" "$W/config.php" "$W/sitrecServer/config.php" "$W/config/shared.env"; do',
    '  [ -f "$f" ] || continue',
    '  printf "configfile\\t%s\\t%s\\t%s\\n" "$f" "$(ls -l "$f" | cut -d" " -f1)" "$(wc -c < "$f" 2>/dev/null | tr -d " ")"',
    '  if [ ! -r "$f" ]; then',
    '    printf "configunreadable\\t%s\\n" "$f"',
    "    continue",
    "  fi",
    '  while IFS= read -r line; do',
    '    case "$(trimws "$line")" in',
    "      \\#*) continue ;;",
    '      *=*) ;;',
    "      *) continue ;;",
    "    esac",
    '    k=$(trimws "${line%%=*}")',
    '    v=$(trimws "${line#*=}")',
    '    case "$k" in "" | *[!A-Za-z0-9_]*) continue ;; esac',
    '    v="${v%\\"}" ; v="${v#\\"}"',
    "    v=\"${v%\\'}\" ; v=\"${v#\\'}\"",
    '    n=$(printf "%s" "$v" | wc -c | tr -d " ")',
    '    verdict=set',
    '    [ "$n" -eq 0 ] && verdict=empty',
    '    vu=$(printf "%s" "$v" | tr "[:lower:]" "[:upper:]")',
    '    case "$vu" in',
    "      EXAMPLEKEY|EXAMPLE_KEY|EXAMPLE|CHANGEME|CHANGE_ME|PLACEHOLDER|TODO|NONE|NULL|UNSET|YOUR_KEY_HERE|YOUR_API_KEY|YOURKEYHERE)",
    "        verdict=placeholder ;;",
    '      "<"*">") verdict=placeholder ;;',
    "    esac",
    '    printf "configkey\\t%s\\t%s\\t%s\\t%s\\n" "$f" "$k" "$n" "$verdict"',
    '  done < "$f"',
    "done",
    "",
    "# Last line, always. Its absence means the probe died part-way through, which would",
    "# otherwise look like a complete sweep that happened to find less.",
    'printf "probecomplete\\t1\\n"',
];

const PROBE_SCRIPT = PROBE_LINES.join("\n");

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

function run(cmd, args, {input, maxBuffer = 1 << 28} = {}) {
    const r = spawnSync(cmd, args, {encoding: "utf8", input, maxBuffer});
    return {
        status: r.status,
        stdout: r.stdout || "",
        stderr: r.stderr || "",
        error: r.error,
    };
}

function which(cmd) {
    const r = spawnSync("command", ["-v", cmd], {encoding: "utf8", shell: true});
    return r.status === 0 ? (r.stdout || "").trim() : null;
}

function toolVersion(cmd, args = ["--version"]) {
    const r = run(cmd, args);
    return (r.stdout || r.stderr || "").split("\n")[0].trim() || "unknown";
}

// ---------------------------------------------------------------------------
// Evidence collection
// ---------------------------------------------------------------------------

/**
 * Runs every collector and returns the evidence object, also writing each raw artifact to
 * <outDir>/evidence/ so the report can be regenerated or independently checked later.
 */
export function collectEvidence({image, engine, outDir, dockerfile, log = () => {}}) {
    const evidenceDir = path.join(outDir, "evidence");
    fs.mkdirSync(evidenceDir, {recursive: true});

    const writeEvidence = (name, data) => {
        const file = path.join(evidenceDir, name);
        fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
        return file;
    };

    const ev = {
        collectedAt: new Date().toISOString(),
        image,
        engine,
        toolVersion: TOOL_VERSION,
        tools: {},
        errors: [],
    };

    ev.tools[engine] = toolVersion(engine);
    ev.tools.trivy = toolVersion("trivy");
    ev.tools.syft = toolVersion("syft");

    // --- image configuration -------------------------------------------------
    log("  image configuration");
    const insp = run(engine, ["image", "inspect", image]);
    if (insp.status !== 0) {
        // `image inspect` reads the LOCAL image store and never pulls, so a reference that
        // exists only in a registry fails here with "No such image" — which reads like the
        // image does not exist at all. Say the actual remedy. Pulling is deliberately left
        // to the operator rather than done here: it is a network action, and an automatic
        // pull could quietly review something other than the image they meant.
        const missing = /no such image|image not known|manifest unknown/i.test(insp.stderr);
        throw new Error(
            `${engine} image inspect ${image} failed:\n${insp.stderr.trim()}`
            + (missing
                ? `\n\nThe image is not in the local ${engine} image store. This tool reviews a`
                  + ` local image and does not pull. Fetch it first, then re-run:\n`
                  + `  ${engine} pull ${image}`
                : ""));
    }
    // Classify Env credentials BEFORE redacting, then keep only the redacted config. The
    // raw value is never stored, never written and never returned.
    const rawInspect = JSON.parse(insp.stdout)[0];
    ev.envCredentials = envCredentials(rawInspect);
    ev.inspect = redactInspect(rawInspect);
    writeEvidence("inspect.json", ev.inspect);

    // --- layer history -------------------------------------------------------
    log("  layer history");
    const hist = run(engine, ["history", "--no-trunc", "--format", "{{json .}}", image]);
    ev.history = redactHistory(hist.status === 0
        ? hist.stdout.split("\n").filter(Boolean).map((l) => {
            try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean)
        : []);
    writeEvidence("history.json", ev.history);

    // --- in-image probe ------------------------------------------------------
    // No network, no new privileges: the probe cannot reach out, and the run doubles as
    // evidence that the image starts under those restrictions.
    log("  filesystem probe (container, no network)");
    // Run the probe as UID 0 rather than as the image's declared user. This is an
    // INSPECTION of image contents, not a simulation of the runtime: a probe running as the
    // image's own non-root user cannot read a root-only file or descend into a root-only
    // directory, and would report the resulting silence as a clean image. What the image
    // declares as its user is a separate fact, already reported by CFG-01.
    //
    // Rootless podman maps --user 0 to namespace root, which reads image content fine. A
    // runtime that refuses to run anything as root falls back to the default user, and the
    // reduced coverage is then recorded and carried into the report.
    const probeArgs = (userArgs) => [
        "run", "--rm",
        "--network=none",
        "--security-opt", "no-new-privileges",
        ...userArgs,
        "--entrypoint", "sh",
        image, "-c", PROBE_SCRIPT,
    ];
    let probe = run(engine, probeArgs(["--user", "0"]));
    ev.probeRanAsRoot = true;
    if (probe.status !== 0) {
        const fallback = run(engine, probeArgs([]));
        if (fallback.status === 0) {
            probe = fallback;
            ev.probeRanAsRoot = false;
        }
    }
    if (probe.status !== 0) {
        ev.errors.push(`filesystem probe exited ${probe.status}: ${probe.stderr.trim().slice(0, 500)}`);
    }
    ev.probe = parseProbe(probe.stdout);
    writeEvidence("probe.json", ev.probe);
    writeEvidence("probe-raw.txt", probe.stdout);

    // A probe that did not run produces an EMPTY evidence set, and an empty evidence set
    // makes every check that reads it look clean. For a release gate that is the worst
    // possible failure mode: a credential-bearing image would sail through because nothing
    // was examined. So record whether the probe actually produced evidence, and let
    // evaluate() turn "not examined" into a finding rather than a pass.
    //
    // Zero records is treated as a failure even on a zero exit status: this probe always
    // finds /tmp world-writable and several base-image tools, so an empty result means it
    // did not really run, whatever it returned.
    // Completeness is asserted by the probe's own final record, not inferred from a record
    // count. A probe killed part-way through emits plenty of records and a zero-ish status,
    // and counting records would call that a successful sweep that merely found less.
    const recordCount = Object.values(ev.probe)
        .reduce((n, v) => n + (Array.isArray(v) ? v.length : (v ? 1 : 0)), 0);
    ev.probeOk = probe.status === 0 && ev.probe.complete === true && recordCount > 0;
    if (!ev.probeOk && probe.status === 0) {
        ev.errors.push(ev.probe.complete
            ? "filesystem probe returned no records; treating its evidence as unavailable"
            : "filesystem probe did not run to completion (no completion record); treating its evidence as unavailable");
    }
    if (ev.probeOk && ev.probeRanAsRoot === false) {
        log(`  note: probe ran as UID ${ev.probe.uid}; root-only paths may be unreadable`);
    }

    // --- vulnerabilities -----------------------------------------------------
    log("  vulnerability scan (trivy)");
    const vulnFile = path.join(evidenceDir, "trivy-vulnerabilities.json");
    const vuln = run("trivy", [
        "image", "--quiet", "--scanners", "vuln",
        "--format", "json", "--output", vulnFile, image,
    ]);
    if (vuln.status !== 0) ev.errors.push(`trivy vuln scan exited ${vuln.status}: ${vuln.stderr.trim().slice(0, 500)}`);
    ev.trivyVuln = fs.existsSync(vulnFile) ? JSON.parse(fs.readFileSync(vulnFile, "utf8")) : null;

    // --- secrets -------------------------------------------------------------
    log("  secret scan (trivy)");
    const secretFile = path.join(evidenceDir, "trivy-secrets.json");
    const secret = run("trivy", [
        "image", "--quiet", "--scanners", "secret",
        "--format", "json", "--output", secretFile, image,
    ]);
    if (secret.status !== 0) ev.errors.push(`trivy secret scan exited ${secret.status}: ${secret.stderr.trim().slice(0, 500)}`);
    // The raw secret report can quote the matched credential. Keep the finding, drop the
    // match, then overwrite the file on disk so no artifact of this run holds a secret.
    ev.trivySecret = fs.existsSync(secretFile) ? redactSecretReport(JSON.parse(fs.readFileSync(secretFile, "utf8"))) : null;
    if (ev.trivySecret) fs.writeFileSync(secretFile, JSON.stringify(ev.trivySecret, null, 2));

    // --- SBOM ----------------------------------------------------------------
    log("  software bill of materials (syft)");
    const sbomFile = path.join(outDir, "sbom.cdx.json");
    const sbom = run("syft", [image, "-q", "-o", `cyclonedx-json=${sbomFile}`]);
    if (sbom.status !== 0) ev.errors.push(`syft exited ${sbom.status}: ${sbom.stderr.trim().slice(0, 500)}`);
    ev.sbom = fs.existsSync(sbomFile) ? summariseSbom(JSON.parse(fs.readFileSync(sbomFile, "utf8"))) : null;
    ev.sbomPath = fs.existsSync(sbomFile) ? path.relative(PROJECT_ROOT, sbomFile) : null;
    writeEvidence("sbom-summary.json", ev.sbom);

    // --- Dockerfile (base image pinning) -------------------------------------
    ev.dockerfile = null;
    if (dockerfile && fs.existsSync(dockerfile)) {
        const text = fs.readFileSync(dockerfile, "utf8");
        ev.dockerfile = {
            path: path.relative(PROJECT_ROOT, dockerfile),
            from: [...text.matchAll(/^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim)].map((m) => ({
                ref: m[1],
                stage: m[2] || null,
            })),
        };
    }

    writeEvidence("evidence.json", ev);
    return ev;
}

/** Parses the probe's tab-separated records into arrays keyed by record type. */
export function parseProbe(stdout) {
    const out = {
        uid: null,
        complete: false,
        webroot: null,
        worldWritableDirs: [],
        worldWritableFiles: [],
        setuid: [],
        tools: [],
        sourceMaps: [],
        stray: [],
        endpoints: [],
        configFiles: [],
        configKeys: [],
        unreadableConfigFiles: [],
    };
    for (const line of String(stdout || "").split("\n")) {
        if (!line) continue;
        const f = line.split("\t");
        switch (f[0]) {
            case "uid": out.uid = Number(f[1]); break;
            case "probecomplete": out.complete = true; break;
            case "configunreadable": out.unreadableConfigFiles.push(f[1]); break;
            case "webroot": out.webroot = {mode: f[1], owner: f[2]}; break;
            case "wwdir": out.worldWritableDirs.push({mode: f[1], path: f[2]}); break;
            case "wwfile": out.worldWritableFiles.push({mode: f[1], path: f[2]}); break;
            case "suid": out.setuid.push({mode: f[1], path: f[2]}); break;
            case "tool": out.tools.push({name: f[1], path: f[2]}); break;
            case "sourcemap": out.sourceMaps.push(f[1]); break;
            case "stray": out.stray.push(f[1]); break;
            case "endpoint": out.endpoints.push(f[1]); break;
            case "configfile": out.configFiles.push({path: f[1], mode: f[2], size: Number(f[3])}); break;
            case "configkey":
                out.configKeys.push({file: f[1], key: f[2], length: Number(f[3]), verdict: f[4]});
                break;
            default: break;
        }
    }
    return out;
}

// A KEY=value pair anywhere in a free-text string, used to redact build commands.
const ASSIGNMENT_RE = /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g;

/** How a value is classified without disclosing it. Mirrors the in-image probe's rule. */
const PLACEHOLDER_VALUES = new Set([
    "EXAMPLEKEY", "EXAMPLE_KEY", "EXAMPLE", "CHANGEME", "CHANGE_ME", "PLACEHOLDER",
    "TODO", "NONE", "NULL", "UNSET", "YOUR_KEY_HERE", "YOUR_API_KEY", "YOURKEYHERE",
]);

export function classifyValue(raw) {
    const v = String(raw ?? "").trim().replace(/^["']|["']$/g, "");
    if (v === "") return "empty";
    if (PLACEHOLDER_VALUES.has(v.toUpperCase())) return "placeholder";
    if (/^<.*>$/.test(v)) return "placeholder";
    return "set";
}

/**
 * Reads the credential-shaped entries out of an image's Env, classifying each without
 * keeping its value.
 *
 * The probe covers configuration FILES; this covers the other way a credential gets into
 * an image, which is `ENV KEY=value` in a Dockerfile or a --build-arg baked into a layer.
 */
export function envCredentials(inspect) {
    const out = [];
    for (const entry of inspect?.Config?.Env || []) {
        const i = entry.indexOf("=");
        if (i < 1) continue;
        const key = entry.slice(0, i).trim();
        if (!isCredentialKey(key)) continue;
        const value = entry.slice(i + 1);
        out.push({key, file: "image config (ENV)", length: value.trim().length, verdict: classifyValue(value)});
    }
    return out;
}

/**
 * Redacts an image config before it is archived.
 *
 * The evidence directory is uploaded as a build artifact and is meant to be circulatable,
 * which is only true if nothing in it holds a secret. Config.Env is the obvious hazard: an
 * image built with `ENV OPENAI_API=...` would otherwise put a live key straight into
 * evidence/inspect.json. Key names are kept — they are what the report reasons about — and
 * values of credential-shaped keys are replaced by their length.
 */
export function redactInspect(inspect) {
    const out = JSON.parse(JSON.stringify(inspect ?? null));
    if (out?.Config?.Env) {
        out.Config.Env = out.Config.Env.map((entry) => {
            const i = entry.indexOf("=");
            if (i < 1) return entry;
            const key = entry.slice(0, i).trim();
            if (!isCredentialKey(key)) return entry;
            return `${entry.slice(0, i)}=<redacted, ${entry.length - i - 1} chars, ${classifyValue(entry.slice(i + 1))}>`;
        });
    }
    return out;
}

/**
 * Redacts layer history before it is archived. `CreatedBy` holds the full build command,
 * so an `ENV`, an `ARG` default or an inlined `--build-arg` can carry a credential into
 * the evidence bundle.
 */
export function redactHistory(history) {
    return (history || []).map((h) => {
        if (!h || typeof h.CreatedBy !== "string") return h;
        return {
            ...h,
            CreatedBy: h.CreatedBy.replace(ASSIGNMENT_RE, (match, key) =>
                (isCredentialKey(key) ? `${key}=<redacted>` : match)),
        };
    });
}

/**
 * Strips the matched text out of a trivy secret report. Trivy quotes the credential it
 * found in Match/Code; the location and the rule are all a report needs, and keeping the
 * value would put a live secret into an artifact meant to be circulated.
 */
export function redactSecretReport(report) {
    const out = JSON.parse(JSON.stringify(report));
    for (const r of out.Results || []) {
        for (const s of r.Secrets || []) {
            delete s.Match;
            delete s.Code;
        }
    }
    return out;
}

/** Component counts by ecosystem, from a CycloneDX document. */
export function summariseSbom(doc) {
    const byEcosystem = {};
    for (const c of doc.components || []) {
        const purl = c.purl || "";
        const m = /^pkg:([^/]+)\//.exec(purl);
        const key = m ? m[1] : (c.type || "unknown");
        byEcosystem[key] = (byEcosystem[key] || 0) + 1;
    }
    return {
        specVersion: doc.specVersion || null,
        total: (doc.components || []).length,
        byEcosystem,
    };
}

// ---------------------------------------------------------------------------
// Vulnerability shaping
// ---------------------------------------------------------------------------

/**
 * Counts by severity, split by whether a fix exists.
 *
 * The split is the whole point. A Debian base image carries hundreds of open advisories
 * that the distribution has assessed and chosen not to patch in this release; a bare
 * "1547 vulnerabilities, 14 critical" headline says nothing an operator can act on. The
 * number that changes when you rebuild is the FIXABLE count, so the report leads with it
 * and gives the raw total as context.
 */
export function summariseVulnerabilities(trivyVuln) {
    const empty = {total: 0, fixable: 0, bySeverity: {}, fixableBySeverity: {}, topFixable: [], targets: []};
    if (!trivyVuln) return empty;
    const bySeverity = {};
    const fixableBySeverity = {};
    const topFixable = [];
    const targets = [];
    let total = 0;
    let fixable = 0;
    for (const r of trivyVuln.Results || []) {
        const vulns = r.Vulnerabilities || [];
        targets.push({target: r.Target, type: r.Type, class: r.Class, count: vulns.length});
        for (const v of vulns) {
            const sev = String(v.Severity || "UNKNOWN").toUpperCase();
            bySeverity[sev] = (bySeverity[sev] || 0) + 1;
            total++;
            if (v.FixedVersion) {
                fixableBySeverity[sev] = (fixableBySeverity[sev] || 0) + 1;
                fixable++;
                topFixable.push({
                    id: v.VulnerabilityID,
                    severity: sev,
                    pkg: v.PkgName,
                    installed: v.InstalledVersion,
                    fixed: v.FixedVersion,
                    title: (v.Title || "").slice(0, 120),
                });
            }
        }
    }
    topFixable.sort((a, b) => severityRank(b.severity.toLowerCase()) - severityRank(a.severity.toLowerCase()));
    return {
        total,
        fixable,
        bySeverity,
        fixableBySeverity,
        topFixable,
        targets,
        os: trivyVuln.Metadata?.OS || null,
    };
}

// ---------------------------------------------------------------------------
// Baseline (accepted risks)
// ---------------------------------------------------------------------------

export function loadBaseline(file) {
    if (!file || !fs.existsSync(file)) return {acceptedRisks: {}};
    const b = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!b || typeof b !== "object" || typeof b.acceptedRisks !== "object") {
        throw new Error(`${file}: expected an object with an "acceptedRisks" map`);
    }
    for (const [id, entry] of Object.entries(b.acceptedRisks)) {
        if (!entry.reason || !entry.compensatingControl) {
            throw new Error(`${file}: acceptedRisks.${id} must state both "reason" and "compensatingControl"`);
        }
    }
    return b;
}

/**
 * Applies the baseline to a raw check result.
 *
 * An accepted risk covers only the exact items it names in `covers`. If the check reports
 * anything else, the finding stays open and lists just the uncovered items — so a new
 * world-writable path is a finding even though the four expected ones are accepted.
 */
function applyBaseline(check, result, baseline) {
    if (result.status !== "fail" && result.status !== "warn") return result;
    // A "not verified" result carries no items, so a covers[] declaration would vacuously
    // cover all nothing of it and quietly turn the failure into an accepted risk — putting
    // back the fail-open this result exists to prevent. An accepted risk is a statement
    // about evidence that was examined; there is none here.
    if (result.notVerified) return result;
    const entry = baseline.acceptedRisks?.[check.id];
    if (!entry) return result;

    const covers = entry.covers;
    if (!Array.isArray(covers)) {
        // A whole-check acceptance: the finding is a single indivisible fact.
        return {...result, status: "accepted", accepted: entry};
    }
    const items = result.items || [];
    const uncovered = items.filter((i) => !covers.includes(itemKey(i)));
    if (uncovered.length === 0) {
        return {...result, status: "accepted", accepted: entry};
    }
    return {
        ...result,
        items: uncovered,
        summary: `${uncovered.length} item(s) not covered by the accepted-risk declaration`,
        accepted: entry,
        partiallyAccepted: true,
    };
}

// The identity a covers[] entry names. Each check's items carry one natural identifier —
// a path, a configuration key, a tool name, an image reference — and the fallback keeps a
// declaration possible for a shape not listed here, at the cost of naming it as JSON.
const itemKey = (i) => (typeof i === "string" ? i : i.path || i.key || i.name || i.ref || JSON.stringify(i));

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

// Every check is a pure function of the evidence. `severity` is the severity it carries
// WHEN IT FAILS; a passing check has no severity.
export const CHECKS = [
    // --- image ------------------------------------------------------------
    {
        id: "IMG-01",
        area: "image",
        title: "Credentials baked into the image",
        severity: "critical",
        question: "Does any configuration file inside the image hold a real credential?",
        run(ev, profile) {
            // A configuration file that exists but could not be read contributes no keys,
            // which is indistinguishable from a file containing no credentials. Never call
            // that a pass: report it as unverified, at this check's critical severity, so a
            // mode-600 credential file cannot ride out of the gate on a silence.
            const unreadable = ev.probe?.unreadableConfigFiles || [];
            if (unreadable.length) {
                return {
                    status: "fail",
                    notVerified: true,
                    summary: `NOT VERIFIED — ${unreadable.length} configuration file(s) exist in the image but could not be read`,
                    items: unreadable.map((p) => ({path: p})),
                    columns: ["path"],
                    note: `The probe read the image as UID ${ev.probe?.uid ?? "unknown"}. A file it cannot read yields no keys, and no keys looks exactly like no credentials — so this is reported as unverified rather than as a pass. Re-run with a container engine that can start the image as UID 0; this review inspects image contents, and reading them is not the same as running the application.`,
                    remediation: [
                        "Re-run the review with an engine that permits `--user 0` (Docker, or rootless Podman, both do).",
                        "Until it has been read, treat the file as if it held live credentials.",
                    ],
                };
            }
            // Both ways a credential reaches an image: a configuration FILE in a layer,
            // and an ENV baked into the image config by a Dockerfile or a build argument.
            const candidates = [...(ev.probe?.configKeys || []), ...(ev.envCredentials || [])]
                .filter((k) => isCredentialKey(k.key));
            const keys = candidates.filter((k) => k.verdict === "set");
            const placeholders = candidates.filter((k) => k.verdict === "placeholder");
            if (keys.length === 0) {
                return {
                    status: "pass",
                    summary: `no credential-shaped key holds a real value (${placeholders.length} placeholder, ${candidates.filter((k) => k.verdict === "empty").length} empty)`,
                };
            }
            const files = [...new Set(keys.map((k) => k.file))];
            const items = keys.map((k) => ({key: k.key, file: k.file, length: k.length}));
            const columns = ["key", "file", "length"];
            const note = "Values were classified inside the container and never read out; only the key name and the value's length appear here.";

            if (profile === "site") {
                return {
                    status: "info",
                    summary: `${keys.length} live credential(s) baked in by design, in ${files.join(", ")}`,
                    items,
                    columns,
                    note: `${note}\n\nThis image was reviewed as a **site image**: one built for a single deployment with that deployment's own configuration compiled in. The credentials below are expected. What follows from them is a handling requirement, not a defect.`,
                    remediation: [
                        "Treat this image as being exactly as sensitive as the credentials it carries. Anyone who can pull it can read them with `docker save`; the `<?php` guard on shared.env.php stops a web server serving the file, it does not stop that.",
                        "Keep it in a registry whose read access matches the credentials' own, and never push it to a public or shared registry, nor to the registry the published images go to.",
                        "For an image that will be distributed, build with `SITREC_SHARED_ENV=config/shared.env.example` and supply the real values as environment variables at container start — the entrypoint regenerates shared.env.php from the environment at every start, so nothing is lost by leaving them out of the layers.",
                    ],
                };
            }
            return {
                status: "fail",
                summary: `${keys.length} credential(s) present with a real value, in ${files.join(", ")}`,
                items,
                columns,
                note: `${note}\n\nThis image was reviewed as a **published image**: one other people pull. A published image must carry only the shipped placeholders.`,
                remediation: [
                    "Build with `SITREC_SHARED_ENV=config/shared.env.example` so only placeholders are compiled in, and supply the real values at container start as environment variables. The entrypoint writes shared.env.php from the environment at every start, so nothing is lost.",
                    "Treat every credential listed above as disclosed to everyone who could pull this image, and rotate it.",
                    "If this image was built deliberately for one deployment, re-run with `--profile=site`, which reports the same facts as a handling requirement instead of a defect.",
                ],
            };
        },
    },
    {
        id: "IMG-02",
        area: "image",
        title: "Secret-scanner findings",
        severity: "critical",
        question: "Does a general-purpose secret scanner find credential-shaped strings in any layer?",
        run(ev, profile) {
            if (!ev.trivySecret) return {status: "skip", summary: "no secret-scan evidence"};
            const hits = [];
            for (const r of ev.trivySecret.Results || []) {
                for (const s of r.Secrets || []) {
                    hits.push({path: r.Target, rule: s.RuleID, severity: String(s.Severity || "").toLowerCase(), title: s.Title});
                }
            }
            if (hits.length === 0) return {status: "pass", summary: "no secret-scanner findings"};
            const note = "The matched text is stripped from the evidence file; only the rule and the location are kept. This scanner recognises credentials by shape, so it finds well-known formats and misses the rest — IMG-01, which knows Sitrec's own configuration keys by name, is the more complete check of the two.";
            if (profile === "site") {
                return {
                    status: "info",
                    summary: `${hits.length} secret-scanner finding(s), expected in a site image`,
                    items: hits,
                    columns: ["path", "rule", "severity", "title"],
                    note,
                    remediation: ["See IMG-01 for how this image must be handled."],
                };
            }
            return {
                status: "fail",
                summary: `${hits.length} secret-scanner finding(s)`,
                items: hits,
                columns: ["path", "rule", "severity", "title"],
                note,
                remediation: ["Remove the file from the image, or build it with placeholder values (see IMG-01)."],
            };
        },
    },
    {
        id: "IMG-03",
        area: "image",
        title: "Known-vulnerable packages with a fix available",
        severity: "high",
        question: "How many advisories against packages in this image can be closed by rebuilding?",
        run(ev) {
            const v = summariseVulnerabilities(ev.trivyVuln);
            if (!ev.trivyVuln) return {status: "skip", summary: "no vulnerability-scan evidence"};
            const crit = v.fixableBySeverity.CRITICAL || 0;
            const high = v.fixableBySeverity.HIGH || 0;
            const summary = `${v.fixable} of ${v.total} advisories have a fixed version (${crit} critical, ${high} high)`;
            if (crit > 0) {
                return {status: "fail", summary, items: v.topFixable.slice(0, 25), columns: ["severity", "id", "pkg", "installed", "fixed"],
                    remediation: ["Rebuild on a current base image, which picks up the distribution's patched packages."]};
            }
            if (high > 0) {
                return {status: "warn", summary, items: v.topFixable.slice(0, 25), columns: ["severity", "id", "pkg", "installed", "fixed"],
                    remediation: ["Rebuild on a current base image to pick up the fixed versions listed above."]};
            }
            return {status: "pass", summary, items: v.topFixable.slice(0, 25), columns: ["severity", "id", "pkg", "installed", "fixed"]};
        },
    },
    {
        id: "IMG-04",
        area: "image",
        title: "Advisories with no fix available",
        severity: "info",
        question: "What is the residual, unfixable advisory load the deployment inherits from the base image?",
        run(ev) {
            if (!ev.trivyVuln) return {status: "skip", summary: "no vulnerability-scan evidence"};
            const v = summariseVulnerabilities(ev.trivyVuln);
            const unfixable = v.total - v.fixable;
            const rows = Object.entries(v.bySeverity)
                .sort((a, b) => severityRank(b[0].toLowerCase()) - severityRank(a[0].toLowerCase()))
                .map(([sev, count]) => ({
                    severity: sev,
                    total: count,
                    fixable: v.fixableBySeverity[sev] || 0,
                    "no fix": count - (v.fixableBySeverity[sev] || 0),
                }));
            return {
                status: "info",
                summary: `${unfixable} advisories have no fixed version in ${v.os ? `${v.os.Family} ${v.os.Name}` : "this base image"}`,
                items: rows,
                columns: ["severity", "total", "fixable", "no fix"],
                note: "These are advisories the distribution has assessed and not patched in this release. They cannot be closed by rebuilding; they are closed by moving base image, or accepted and re-reviewed when the distribution issues an update.",
            };
        },
    },

    // --- configuration ----------------------------------------------------
    {
        id: "CFG-01",
        area: "config",
        title: "Default user is not root",
        severity: "high",
        question: "If the operator applies no user policy at all, what does the container run as?",
        run(ev) {
            const user = ev.inspect?.Config?.User || "";
            if (user && user !== "0" && user !== "root") {
                return {status: "pass", summary: `image declares USER ${user}`};
            }
            return {
                status: "fail",
                summary: "no USER is declared, so the container runs as root unless the operator overrides it",
                remediation: [
                    "Run with an explicit non-root identity: `--user 33:33` (docker/podman), or `securityContext.runAsUser` / `runAsNonRoot: true` in a Kubernetes deployment.",
                    "The image is built to work under any UID — it listens on the unprivileged port 8080 and its writable paths are world-writable for exactly this reason — so no image change is needed to run it non-root.",
                ],
            };
        },
    },
    {
        id: "CFG-02",
        area: "config",
        title: "No privileged port is required",
        severity: "medium",
        question: "Does the image need to bind a port below 1024, which only root can do?",
        run(ev) {
            const ports = Object.keys(ev.inspect?.Config?.ExposedPorts || {});
            const privileged = ports.filter((p) => Number.parseInt(p, 10) < 1024);
            if (privileged.length === 0) {
                return {status: "pass", summary: `declares ${ports.join(", ") || "no ports"}, all unprivileged`};
            }
            return {
                status: "warn",
                summary: `declares privileged port(s): ${privileged.join(", ")}`,
                items: ports.map((p) => ({port: p, privileged: Number.parseInt(p, 10) < 1024 ? "yes" : "no"})),
                columns: ["port", "privileged"],
                note: "This image's own EXPOSE is the unprivileged port; the privileged entry is inherited from the base image, and Docker provides no way to remove an exposed port a parent image declared — there is no `UNEXPOSE`.\n\nIt is not only a declaration. When the container runs as root — the default, since no USER is declared — the entrypoint deliberately adds a second listener on port 80, so that port mappings written before this image moved to an unprivileged port keep working. Running under a non-root UID stops that listener being created at all.",
                remediation: [
                    "Publish only the unprivileged port in the mapping (`-p 8080:8080`). An exposed port that is not published is not reachable from outside the container's network, whatever the image declares.",
                    "Run as a non-root user (`--user 33:33`), which prevents the extra privileged listener from being created and closes CFG-01 at the same time. Note that this also stops a legacy mapping to the privileged port working, silently — the container stays healthy and serves nothing.",
                    "The declaration itself cannot be removed while this base image is used; changing it would mean changing base image.",
                ],
            };
        },
    },
    {
        id: "CFG-03",
        area: "config",
        title: "Health check defined",
        severity: "low",
        question: "Can the orchestrator tell a wedged container from a healthy one?",
        run(ev) {
            const hc = ev.inspect?.Config?.Healthcheck;
            if (hc && Array.isArray(hc.Test) && hc.Test.length && hc.Test[0] !== "NONE") {
                return {status: "pass", summary: `HEALTHCHECK: ${hc.Test.join(" ")}`};
            }
            return {
                status: "warn",
                summary: "no HEALTHCHECK is declared",
                remediation: [
                    "Add a HEALTHCHECK to the image, or define the equivalent probe in the deployment (`healthCheck` in a task definition, `livenessProbe`/`readinessProbe` in Kubernetes). A request for `/` on the listen port is sufficient.",
                ],
            };
        },
    },
    {
        id: "CFG-04",
        area: "config",
        title: "Build and network tooling left in the runtime image",
        severity: "medium",
        question: "What would an attacker who achieves code execution in the container find already installed?",
        run(ev) {
            const tools = ev.probe?.tools || [];
            // Anything that compiles code, installs packages, or opens a network connection.
            const notable = new Set([
                "gcc", "g++", "cc", "make", "ld", "as",
                "pip", "pip3", "apt", "apt-get", "dpkg", "rpm", "apk", "yum",
                "curl", "wget", "git", "npm", "yarn", "composer",
                "nc", "ncat", "socat", "ssh", "sshd", "sudo", "strace", "gdb",
            ]);
            const found = tools.filter((t) => notable.has(t.name));
            if (found.length === 0) return {status: "pass", summary: "no compiler, package manager or network client found"};
            return {
                status: "warn",
                summary: `${found.length} build or network tool(s) present: ${found.map((t) => t.name).join(", ")}`,
                items: found,
                columns: ["name", "path"],
                note: "Most of these are inherited from the base image. They do not create a way in; they widen what an attacker can do once in.",
                remediation: [
                    "Where the environment mandates a minimal runtime, build the final stage on a slim base and copy in only the PHP runtime, Apache and the application.",
                    "Otherwise close the gap at runtime: a read-only root filesystem and a dropped capability set stop most of this tooling from being useful, and egress restrictions stop the network clients reaching anything.",
                ],
            };
        },
    },

    // --- filesystem -------------------------------------------------------
    {
        id: "FS-01",
        area: "filesystem",
        title: "World-writable directories",
        severity: "high",
        question: "Which directories can any process in the container write to, including the one serving the application?",
        run(ev) {
            const dirs = ev.probe?.worldWritableDirs || [];
            if (dirs.length === 0) return {status: "pass", summary: "no world-writable directories"};
            const sticky = (mode) => mode.endsWith("t") || mode.endsWith("T");
            return {
                status: "fail",
                summary: `${dirs.length} world-writable director(ies)`,
                items: dirs.map((d) => ({path: d.path, mode: d.mode, sticky: sticky(d.mode) ? "yes" : "no"})),
                columns: ["path", "mode", "sticky"],
                note: "A world-writable directory without the sticky bit lets any user in the container replace files it holds, including files owned by root.",
                remediation: [
                    "Run the container with a read-only root filesystem and mount only the paths that must be writable as tmpfs or volumes.",
                    "Where a path is world-writable so that an arbitrary UID can write it, prefer group ownership with a fixed GID and `fsGroup` in the deployment.",
                ],
            };
        },
    },
    {
        id: "FS-02",
        area: "filesystem",
        title: "World-writable files",
        severity: "high",
        question: "Can any process in the container rewrite a file in place?",
        run(ev) {
            const files = ev.probe?.worldWritableFiles || [];
            if (files.length === 0) return {status: "pass", summary: "no world-writable files"};
            return {
                status: "fail",
                summary: `${files.length} world-writable file(s)`,
                items: files.slice(0, 50),
                columns: ["path", "mode"],
                remediation: ["Remove the world-write bit in the image build; a process that must write should own the file or share its group."],
            };
        },
    },
    {
        id: "FS-03",
        area: "filesystem",
        title: "setuid and setgid binaries",
        severity: "medium",
        question: "What privilege-raising binaries does the image carry?",
        run(ev) {
            const suid = ev.probe?.setuid || [];
            if (suid.length === 0) return {status: "pass", summary: "no setuid or setgid binaries"};
            return {
                status: "warn",
                summary: `${suid.length} setuid/setgid binar(ies), all inherited from the base image`,
                items: suid,
                columns: ["path", "mode"],
                note: "None is used by the application. They are the base distribution's account and mount utilities.",
                remediation: [
                    "Start the container with `no-new-privileges` (`--security-opt no-new-privileges`, or `allowPrivilegeEscalation: false`): the setuid bit is then inert regardless of what is on disk.",
                    "For a stricter posture, strip the bits in the image build (`chmod -s`) or build on a base that does not ship them.",
                ],
            };
        },
    },
    {
        id: "FS-04",
        area: "filesystem",
        title: "No source maps in the served webroot",
        severity: "medium",
        question: "Would a browser be able to download the unminified source and its comments?",
        run(ev) {
            const maps = ev.probe?.sourceMaps || [];
            if (maps.length === 0) return {status: "pass", summary: "no .map files under the webroot"};
            return {
                status: "fail",
                summary: `${maps.length} source map(s) served`,
                items: maps.map((p) => ({path: p})),
                columns: ["path"],
                remediation: ["Build the deployed artifact in production mode; the bundle egress audit already fails on this, so an image carrying one was built from a debug bundle."],
            };
        },
    },
    {
        id: "FS-05",
        area: "filesystem",
        title: "No development or private material in the webroot",
        severity: "high",
        question: "Did anything that should never be published get packaged?",
        run(ev) {
            const stray = ev.probe?.stray || [];
            if (stray.length === 0) return {status: "pass", summary: "no repository, dependency or private directory under the webroot"};
            return {
                status: "fail",
                summary: `${stray.length} path(s) that should not be packaged`,
                items: stray.map((p) => ({path: p})),
                columns: ["path"],
                remediation: ["Add the path to .dockerignore and to the build's copy patterns, then rebuild."],
            };
        },
    },

    // --- provenance -------------------------------------------------------
    {
        id: "PRV-01",
        area: "registry",
        title: "Base image pinned by digest",
        severity: "medium",
        question: "Does rebuilding this Dockerfile tomorrow produce the same base layers?",
        run(ev) {
            const labels = ev.inspect?.Config?.Labels || {};
            const labelDigest = labels["org.opencontainers.image.base.digest"];
            if (labelDigest) return {status: "pass", summary: `base pinned by label: ${labelDigest}`};
            const froms = ev.dockerfile?.from || [];
            if (froms.length === 0) return {status: "skip", summary: "no Dockerfile available to inspect"};
            const floating = froms.filter((f) => !f.ref.includes("@sha256:") && !/^\$/.test(f.ref));
            if (floating.length === 0) return {status: "pass", summary: "every FROM is pinned by digest"};
            return {
                status: "warn",
                summary: `${floating.length} of ${froms.length} FROM line(s) use a floating tag`,
                items: floating.map((f) => ({ref: f.ref, stage: f.stage || "final"})),
                columns: ["ref", "stage"],
                note: `From ${ev.dockerfile.path}. A tag is a moving pointer: the same Dockerfile built a week apart can produce different base layers, so an approved image cannot be reproduced from source.`,
                remediation: [
                    "Pin each FROM to a digest, e.g. `FROM php:8.4-apache@sha256:<digest>`, and record the digest change as a deliberate update.",
                    "Independently of this, the deployment must pin the application image by digest rather than tag — see the deployment guide's task-definition section.",
                ],
            };
        },
    },
    {
        id: "PRV-02",
        area: "registry",
        title: "Image carries provenance labels",
        severity: "medium",
        question: "Can this image be tied back to the commit it was built from, without trusting the tag?",
        run(ev) {
            const labels = ev.inspect?.Config?.Labels || {};
            const wanted = [
                "org.opencontainers.image.revision",
                "org.opencontainers.image.version",
                "org.opencontainers.image.source",
                "org.opencontainers.image.created",
            ];
            const missing = wanted.filter((l) => !labels[l]);
            if (missing.length === 0) {
                return {status: "pass", summary: "revision, version, source and created are all labelled",
                    items: wanted.map((l) => ({label: l, value: labels[l]})), columns: ["label", "value"]};
            }
            return {
                status: "warn",
                summary: `${missing.length} of ${wanted.length} provenance label(s) missing`,
                items: missing.map((l) => ({label: l, value: "(absent)"})),
                columns: ["label", "value"],
                note: "Without these a reviewer cannot tell which source revision an image came from, and an image that has been retagged is indistinguishable from one that has not.",
                remediation: ["Emit the standard OCI labels at build time; the metadata action already computes them, they are simply not being passed to the build."],
            };
        },
    },
    {
        id: "PRV-03",
        area: "registry",
        title: "Image age",
        severity: "low",
        question: "How stale are the packages in this image likely to be?",
        run(ev) {
            const created = ev.inspect?.Created;
            if (!created) return {status: "skip", summary: "no creation timestamp"};
            const days = Math.floor((Date.now() - Date.parse(created)) / 86400000);
            const summary = `built ${created} (${days} day(s) ago)`;
            if (days > 90) {
                return {status: "warn", summary, remediation: ["Rebuild: a base image more than about a quarter old has accumulated distribution security updates that a rebuild picks up for free."]};
            }
            return {status: "pass", summary};
        },
    },

    // --- application surface ----------------------------------------------
    {
        id: "APP-01",
        area: "app",
        title: "Server endpoint surface",
        severity: "info",
        question: "Which server endpoints does this image expose over HTTP?",
        run(ev) {
            const endpoints = ev.probe?.endpoints || [];
            if (endpoints.length === 0) return {status: "skip", summary: "no server directory found in the image"};
            return {
                status: "info",
                summary: `${endpoints.length} server endpoint(s) under /sitrecServer`,
                items: endpoints.sort().map((e) => ({endpoint: e})),
                columns: ["endpoint"],
                note: "The secure build packages only the allow-listed subset of endpoints; every endpoint that fetches from a public data provider on the browser's behalf is left out at build time. Compare this list against scripts/secure-server-allowlist.json to confirm which build this image was made from.",
            };
        },
    },
    {
        id: "APP-02",
        area: "app",
        title: "Webroot ownership and mode",
        severity: "info",
        question: "Who owns the directory Apache serves, and who can write to it?",
        run(ev) {
            const wr = ev.probe?.webroot;
            if (!wr) return {status: "skip", summary: "webroot not found"};
            return {
                status: "info",
                summary: `/var/www/html is ${wr.mode}, owned by ${wr.owner}`,
                note: "The entrypoint rewrites shared.env.php, index.html and the runtime settings script at every container start. It does so by deleting and recreating them, which is why the directory is world-writable and non-sticky: a non-root UID cannot modify a root-owned file in place under an overlay filesystem, but it can replace one in a writable, non-sticky directory. That mechanism is what lets the image run under an arbitrary assigned UID.",
            };
        },
    },
    {
        id: "APP-03",
        area: "app",
        title: "Configuration files present in the image",
        severity: "info",
        question: "Which configuration files ship inside the image, and how large are they?",
        run(ev) {
            const files = ev.probe?.configFiles || [];
            if (files.length === 0) return {status: "pass", summary: "no configuration file is baked into the image"};
            const keys = ev.probe?.configKeys || [];
            return {
                status: "info",
                summary: `${files.length} configuration file(s) in the image`,
                items: files.map((f) => ({
                    path: f.path,
                    mode: f.mode,
                    bytes: f.size,
                    keys: keys.filter((k) => k.file === f.path).length,
                    "credentials set": keys.filter((k) => k.file === f.path && isCredentialKey(k.key) && k.verdict === "set").length,
                })),
                columns: ["path", "mode", "bytes", "keys", "credentials set"],
                note: "The entrypoint regenerates shared.env.php from the environment at every container start, so a copy baked into the image is never the one in use at run time — but it is still readable in the layer by anyone who can pull the image. IMG-01 is the check that judges its contents.",
            };
        },
    },
];

// ---------------------------------------------------------------------------
// Runtime policy derivation
// ---------------------------------------------------------------------------

/**
 * Turns the findings into the concrete restrictions this image will tolerate. This is the
 * part an operator can act on the same afternoon, so it is derived rather than fixed: if a
 * later image declares a non-root USER, the recommendation stops asking for `--user`.
 */
const WEBROOT = "/var/www/html";

export function derivePolicy(results, ev) {
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    const notes = [];
    const dockerFlags = [];
    const k8s = [];

    if (byId["CFG-01"]?.status !== "pass") {
        dockerFlags.push("--user 33:33");
        k8s.push("runAsNonRoot: true", "runAsUser: 33", "runAsGroup: 33");
        notes.push("The image declares no USER, so the runtime must supply one. 33 is www-data; the image runs under any UID, so the exact value is the deployment's choice.");
    }
    if (byId["FS-03"]?.status !== "pass") {
        dockerFlags.push("--security-opt no-new-privileges");
        k8s.push("allowPrivilegeEscalation: false");
        notes.push("Renders the base image's setuid binaries inert.");
    }
    dockerFlags.push("--cap-drop ALL");
    k8s.push("capabilities:\n      drop: [ALL]");
    notes.push("Apache on an unprivileged port needs no capability at all.");

    // A world-writable path can be handed a tmpfs only if the image leaves it EMPTY. The
    // webroot is the exception that matters: it holds the application, so a tmpfs over it
    // would mount an empty directory on top of everything Apache serves and the container
    // would serve nothing. It has to stay writable in place instead.
    const writable = (ev.probe?.worldWritableDirs || [])
        .map((d) => d.path)
        .filter((p) => p === "/tmp" || p === "/var/tmp" || p.startsWith("/run") || p.startsWith("/var/log") || p.startsWith(`${WEBROOT}/`));
    const webrootWritable = (ev.probe?.worldWritableDirs || []).some((d) => d.path === WEBROOT);

    // --read-only is only recommended when it would actually work. The entrypoint rewrites
    // shared.env.php, index.html and the runtime settings script inside the webroot at
    // every start, so with a read-only root filesystem and no writable webroot the
    // container fails during start-up. Emitting the flag anyway would hand the operator a
    // command that does not run — worse than omitting it, because it looks authoritative.
    for (const w of writable) dockerFlags.push(`--tmpfs ${w}`);
    if (writable.length) {
        notes.push("The tmpfs mounts make the image's world-writable scratch directories ephemeral: they start empty and nothing written to them survives a restart. Each one is empty in the image, so replacing it with a tmpfs loses nothing.");
    }

    if (webrootWritable) {
        dockerFlags.push(`--mount type=volume,dst=${WEBROOT}/sitrec-videos`);
        notes.push(`**A read-only root filesystem is NOT recommended for this image as built, and is deliberately absent from the command above.** The entrypoint rewrites shared.env.php, index.html and the runtime settings script inside ${WEBROOT} at every container start; with \`--read-only\` (or \`readOnlyRootFilesystem: true\`) and no writable webroot, start-up fails. A tmpfs over ${WEBROOT} is not the answer either — it would mount an empty directory on top of the application and the container would serve nothing.`);
        notes.push(`To get a read-only root filesystem, remove the need for that rewrite: build the image with its settings already baked in rather than injecting them at start, and then \`--read-only\` can be added with the tmpfs mounts above. That trades reconfiguring a container without rebuilding it for a webroot nothing can write. FS-01 is the finding this answers.`);
    } else {
        dockerFlags.push("--read-only");
        k8s.push("readOnlyRootFilesystem: true");
        notes.push("The webroot is not writable, so a read-only root filesystem is safe here: only the paths mounted above can be written.");
    }

    return {dockerFlags, k8s, notes};
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export const PROFILES = {
    published: {
        title: "Published image",
        blurb: "An image other people pull. It must carry only the shipped configuration placeholders; a real credential in it is a disclosure to everyone with pull access, and is reported as a critical failure.",
    },
    site: {
        title: "Site image",
        blurb: "An image built for one deployment with that deployment's own configuration compiled in. Credentials in it are expected and are reported as a handling requirement rather than a defect — the image is as sensitive as what it carries.",
    },
};

// Checks whose whole verdict comes from the in-image probe. If the probe produced no
// evidence, these cannot be answered, and answering them anyway would answer them wrongly:
// an empty evidence set reads as a clean image.
const PROBE_DEPENDENT = new Set([
    "IMG-01", "CFG-04", "FS-01", "FS-02", "FS-03", "FS-04", "FS-05", "APP-01", "APP-02", "APP-03",
]);

/** True when the probe's evidence is absent, whatever the reason. */
export function probeEvidenceMissing(ev) {
    if (ev.probeOk === false) return true;
    if (ev.probeOk === true) return false;
    // Evidence archived before probeOk existed: judge it by its own content instead.
    const n = Object.values(ev.probe || {})
        .reduce((a, v) => a + (Array.isArray(v) ? v.length : (v ? 1 : 0)), 0);
    return n === 0;
}

export function evaluate(ev, baseline = {acceptedRisks: {}}, profile = "published") {
    const results = [];
    const noProbe = probeEvidenceMissing(ev);
    for (const check of CHECKS) {
        let raw;
        if (noProbe && PROBE_DEPENDENT.has(check.id)) {
            // Fail closed. "Not examined" is a finding, never a pass — otherwise a probe
            // that failed to run would let a credential-bearing image through the gate.
            raw = {
                status: "fail",
                notVerified: true,
                summary: "NOT VERIFIED — the in-image filesystem probe produced no evidence",
                note: "This check reads the container's own filesystem, and that read did not happen, so nothing here has been confirmed either way. It is reported as a failure rather than a pass because an empty evidence set is indistinguishable from a clean image, and treating the two alike would make this review worthless exactly when it is needed. See the collection errors at the end of this report.",
                remediation: [
                    "Re-run the review. The usual causes are a container engine that could not start the image, an image built for another architecture, or a runtime that refuses `--network=none` or `--security-opt no-new-privileges`.",
                ],
            };
        } else {
            try {
                raw = check.run(ev, profile) || {status: "skip", summary: "check produced no result"};
            } catch (err) {
                raw = {status: "skip", summary: `check errored: ${err.message}`};
            }
            // A sweep made by a non-root UID silently skips root-only paths, so a clean
            // result from one is weaker evidence than a clean result from a complete sweep.
            // Say so on the finding itself rather than only in a footnote.
            if (PROBE_DEPENDENT.has(check.id) && ev.probeRanAsRoot === false) {
                raw = {
                    ...raw,
                    coverage: "partial",
                    note: `${raw.note ? `${raw.note}\n\n` : ""}**Partial coverage.** This engine would not start the image as UID 0, so the filesystem was read as UID ${ev.probe?.uid ?? "unknown"}. Paths readable only by root were skipped and are not represented here; a clean result from this run is weaker evidence than one from a complete sweep.`,
                };
            }
        }
        const withBaseline = applyBaseline(check, raw, baseline);
        results.push({
            id: check.id,
            area: check.area,
            title: check.title,
            question: check.question,
            severity: withBaseline.status === "pass" || withBaseline.status === "info" ? "info" : check.severity,
            ...withBaseline,
        });
    }

    const open = results.filter((r) => OPEN_STATUSES.has(r.status));
    const counts = {};
    for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
    const worst = open.reduce((acc, r) => (severityRank(r.severity) > severityRank(acc) ? r.severity : acc), "info");

    return {
        toolVersion: TOOL_VERSION,
        generatedAt: new Date().toISOString(),
        profile,
        image: ev.image,
        imageDigest: ev.inspect?.Id || null,
        repoDigests: ev.inspect?.RepoDigests || [],
        created: ev.inspect?.Created || null,
        size: ev.inspect?.Size ?? null,
        platform: ev.inspect ? `${ev.inspect.Os}/${ev.inspect.Architecture}` : null,
        tools: ev.tools || {},
        collectedAt: ev.collectedAt,
        errors: ev.errors || [],
        counts,
        openFindings: open.length,
        worstOpenSeverity: open.length ? worst : "none",
        vulnerabilities: summariseVulnerabilities(ev.trivyVuln),
        sbom: ev.sbom || null,
        sbomPath: ev.sbomPath || null,
        policy: derivePolicy(results, ev),
        results,
    };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

const bytesHuman = (n) => (n == null ? "unknown" : `${(n / 1e9).toFixed(2)} GB`);

/**
 * One Markdown table cell, from a value that came out of the image under review.
 *
 * The order here is the whole point. Escaping only the pipe — `replace(/\|/g, "\\|")` —
 * is incomplete, because the escape character can arrive in the input: a value containing
 * `\|` becomes `\\|`, which Markdown reads as an escaped backslash followed by a LIVE
 * pipe, and the row gains a column. A newline is worse; it ends the row outright.
 *
 * That matters more here than it would in an ordinary report. Every value passing through
 * this is attacker-influenceable — a file path, a configuration key, a package name, a tool
 * path, all read out of an image someone else may have built. A crafted filename could
 * otherwise reshape the table that reports on it, and a finding that renders wrongly in a
 * security review is a finding that can be hidden.
 *
 * So: backslash first, then pipe, then flatten the line breaks.
 */
export function mdCell(value) {
    if (value === undefined || value === null) return "";
    return String(value)
        .replace(/\\/g, "\\\\")     // must come first — it escapes the escape character
        .replace(/\|/g, "\\|")
        .replace(/\r\n|\r|\n/g, " ");
}

function mdTable(columns, items) {
    if (!items || items.length === 0) return [];
    const out = [];
    out.push(`| ${columns.join(" | ")} |`);
    out.push(`|${columns.map(() => "---").join("|")}|`);
    for (const item of items) {
        const cells = columns.map((c) => mdCell(typeof item === "string" ? item : item[c]));
        out.push(`| ${cells.join(" | ")} |`);
    }
    return out;
}

export function renderMarkdown(report) {
    const L = [];
    // Variadic: several call sites spread a table's lines in with p(...mdTable(...)),
    // and a single-argument version would silently emit only the header row.
    const p = (...lines) => L.push(...(lines.length ? lines : [""]));

    p("# Container security review");
    p();
    p(`**Image** \`${report.image}\`  `);
    p(`**Image ID** \`${report.imageDigest || "unknown"}\`  `);
    if (report.repoDigests?.length) p(`**Registry digest** \`${report.repoDigests.join("`, `")}\`  `);
    p(`**Platform** ${report.platform || "unknown"} · **Size** ${bytesHuman(report.size)} · **Built** ${report.created || "unknown"}  `);
    p(`**Reviewed** ${report.generatedAt} by \`scripts/auditContainerImage.mjs\` ${report.toolVersion}  `);
    p(`**Scanners** ${Object.entries(report.tools).map(([k, v]) => `${k} (${v})`).join(" · ")}`);
    p();
    const prof = PROFILES[report.profile] || PROFILES.published;
    p(`> **Reviewed as: ${prof.title}.** ${prof.blurb}`);
    p();

    // --- summary -----------------------------------------------------------
    p("## Summary");
    p();
    const openBySeverity = {};
    for (const r of report.results) {
        if (OPEN_STATUSES.has(r.status)) openBySeverity[r.severity] = (openBySeverity[r.severity] || 0) + 1;
    }
    if (report.openFindings === 0) {
        p("No open findings. Every check either passed or is covered by a declared accepted risk.");
    } else {
        const parts = SEVERITY_ORDER.slice().reverse().filter((s) => openBySeverity[s]).map((s) => `${openBySeverity[s]} ${s}`);
        p(`**${report.openFindings} open finding(s):** ${parts.join(", ")}.`);
    }
    p();
    p(`Checks: ${Object.entries(report.counts).map(([k, v]) => `${v} ${STATUS_LABEL[k] || k}`).join(" · ")}.`);
    p();
    p("| ID | Check | Result | Severity | Summary |");
    p("|----|-------|--------|----------|---------|");
    for (const r of report.results) {
        const sev = OPEN_STATUSES.has(r.status) ? r.severity : "—";
        p(`| ${r.id} | ${r.title} | ${STATUS_LABEL[r.status]} | ${sev} | ${mdCell(r.summary)} |`);
    }
    p();

    // --- what this review covers ------------------------------------------
    p("## What this review covers");
    p();
    p("This is an automated review of a container **image**, run against the image itself rather than against the source it was built from. It is organised by the control areas of NIST SP 800-190, the public *Application Container Security Guide*.");
    p();
    p("It answers questions about the image and what the image asks of the runtime. It does **not** assess:");
    p();
    p("- the host operating system, kernel or container runtime (SP 800-190 §4.5);");
    p("- the orchestrator's own configuration — network policy, admission control, secret storage (§4.3);");
    p("- the registry's authentication and transport (§4.2.1, §4.2.3);");
    p("- the running deployment's identity, transport and storage controls. Those are verified separately; see the deployment guide's verification section.");
    p();
    p("Evidence for every finding is written alongside this report under `evidence/`, so each conclusion can be re-derived or independently checked. No credential value is read out of the image at any point: configuration values are classified inside the container and only the key name, the value's length and that classification leave it.");
    p();

    // --- vulnerabilities ---------------------------------------------------
    const v = report.vulnerabilities;
    if (v && v.total) {
        p("## Package advisories");
        p();
        p(`The image is ${v.os ? `**${v.os.Family} ${v.os.Name}**` : "based on a Linux distribution"} and carries **${v.total}** open advisories against its installed packages, of which **${v.fixable}** have a fixed version available.`);
        p();
        p("Those two numbers mean different things and should not be added together. The fixable count is the one that changes when the image is rebuilt, and it is the number to act on. The remainder are advisories the distribution has assessed and has not patched in this release; they are closed by changing base image, or accepted and re-reviewed when the distribution issues an update.");
        p();
        p(...mdTable(["severity", "total", "fixable", "no fix"],
            Object.entries(v.bySeverity)
                .sort((a, b) => severityRank(b[0].toLowerCase()) - severityRank(a[0].toLowerCase()))
                .map(([sev, count]) => ({severity: sev, total: count, fixable: v.fixableBySeverity[sev] || 0, "no fix": count - (v.fixableBySeverity[sev] || 0)}))));
        p();
    }

    // --- SBOM --------------------------------------------------------------
    if (report.sbom) {
        p("## Software bill of materials");
        p();
        p(`A CycloneDX ${report.sbom.specVersion} bill of materials listing **${report.sbom.total}** components accompanies this report${report.sbomPath ? ` at \`${path.basename(report.sbomPath)}\`` : ""}.`);
        p();
        p(...mdTable(["ecosystem", "components"], Object.entries(report.sbom.byEcosystem)
            .sort((a, b) => b[1] - a[1])
            .map(([ecosystem, components]) => ({ecosystem, components}))));
        p();
    }

    // --- findings by area --------------------------------------------------
    for (const [areaKey, area] of Object.entries(AREAS)) {
        const rows = report.results.filter((r) => r.area === areaKey);
        if (rows.length === 0 && areaKey !== "policy") continue;
        p(`## ${area.title}`);
        p();
        p(`*${area.nist}*`);
        p();
        p(area.intro);
        p();

        if (areaKey === "policy") {
            const pol = report.policy;
            p("Every restriction below is one this image tolerates as built. They are the operator's to apply — an image cannot impose them on its own runtime.");
            p();
            p("```");
            p("docker run \\");
            for (const f of pol.dockerFlags) p(`    ${f} \\`);
            p("    -p 8080:8080 <image>@<digest>");
            p("```");
            p();
            p("The equivalent Kubernetes `securityContext`:");
            p();
            p("```yaml");
            p("securityContext:");
            for (const line of pol.k8s) p(`  ${line}`);
            p("```");
            p();
            for (const n of pol.notes) p(`- ${n}`);
            p();
            continue;
        }

        for (const r of rows) {
            p(`### ${r.id} — ${r.title}`);
            p();
            p(`**${STATUS_LABEL[r.status]}**${OPEN_STATUSES.has(r.status) ? ` · severity ${r.severity}` : ""} — ${r.summary}`);
            p();
            p(`*${r.question}*`);
            p();
            if (r.accepted) {
                p(`> **Declared accepted risk.** ${r.accepted.reason}`);
                p(">");
                p(`> *Compensating control:* ${r.accepted.compensatingControl}`);
                if (r.partiallyAccepted) {
                    p(">");
                    p("> The declaration does not cover every item found; the uncovered items are listed below and remain open.");
                }
                p();
            }
            if (r.note) {
                p(r.note);
                p();
            }
            if (r.items && r.items.length) {
                p(...mdTable(r.columns || Object.keys(r.items[0]), r.items));
                p();
            }
            if (r.remediation && r.remediation.length) {
                p("**What to do**");
                p();
                for (const rem of r.remediation) p(`- ${rem}`);
                p();
            }
        }
    }

    if (report.errors?.length) {
        p("## Collection errors");
        p();
        p("The following collectors did not complete. Findings that depend on them are marked SKIPPED above.");
        p();
        for (const e of report.errors) p(`- ${e}`);
        p();
    }

    p("---");
    p();
    p(`Generated by \`scripts/auditContainerImage.mjs\` ${report.toolVersion}. Re-run it against any image with \`npm run audit-container -- --image=<ref>\`.`);
    p();
    return L.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const opts = {
        image: "sitrec:local",
        profile: "published",
        engine: null,
        out: path.join(PROJECT_ROOT, "dist-audit"),
        dockerfile: path.join(PROJECT_ROOT, "Dockerfile.release"),
        baseline: path.join(__dirname, "container-audit-baseline.json"),
        fixture: null,
        failOn: "none",
        json: false,
        quiet: false,
    };
    for (const arg of argv) {
        const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
        if (!m) throw new Error(`unrecognised argument: ${arg}`);
        const [, key, value] = m;
        switch (key) {
            case "image": opts.image = value; break;
            case "profile":
                if (!PROFILES[value]) throw new Error(`--profile must be one of: ${Object.keys(PROFILES).join(", ")}`);
                opts.profile = value;
                break;
            case "engine": opts.engine = value; break;
            case "out": opts.out = path.resolve(value); break;
            case "dockerfile": opts.dockerfile = path.resolve(value); break;
            case "baseline": opts.baseline = path.resolve(value); break;
            case "fixture": opts.fixture = path.resolve(value); break;
            case "fail-on": opts.failOn = String(value || "none").toLowerCase(); break;
            case "json": opts.json = true; break;
            case "quiet": opts.quiet = true; break;
            case "help": opts.help = true; break;
            default: throw new Error(`unrecognised option: --${key}`);
        }
    }
    return opts;
}

function requireTools(engineOpt) {
    const engine = engineOpt || (which("docker") ? "docker" : which("podman") ? "podman" : null);
    const missing = [];
    if (!engine) missing.push("docker or podman");
    else if (!which(engine)) missing.push(engine);
    if (!which("trivy")) missing.push("trivy");
    if (!which("syft")) missing.push("syft");
    if (missing.length) {
        throw new Error(
            `missing required tool(s): ${missing.join(", ")}\n\n` +
            "  macOS:  brew install trivy syft\n" +
            "  Linux:  see https://trivy.dev and https://github.com/anchore/syft\n\n" +
            "For an isolated network, see the offline-database section of\n" +
            "docs/dev/Container-Security-Review.md."
        );
    }
    return engine;
}

function main(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (err) {
        console.error(`auditContainerImage: ${err.message}`);
        process.exit(2);
    }
    if (opts.help) {
        console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?/, ""));
        return;
    }

    const log = opts.quiet ? () => {} : (s) => console.log(s);
    fs.mkdirSync(opts.out, {recursive: true});

    let ev;
    if (opts.fixture) {
        const f = path.join(opts.fixture, "evidence.json");
        if (!fs.existsSync(f)) {
            console.error(`auditContainerImage: no evidence.json in ${opts.fixture}`);
            process.exit(2);
        }
        ev = JSON.parse(fs.readFileSync(f, "utf8"));
        log(`Re-rendering from archived evidence: ${path.relative(PROJECT_ROOT, f)}`);
    } else {
        let engine;
        try {
            engine = requireTools(opts.engine);
        } catch (err) {
            console.error(`auditContainerImage: ${err.message}`);
            process.exit(2);
        }
        log(`Reviewing ${opts.image} with ${engine} (profile: ${opts.profile})`);
        try {
            ev = collectEvidence({
                image: opts.image,
                engine,
                outDir: opts.out,
                dockerfile: opts.dockerfile,
                log,
            });
        } catch (err) {
            console.error(`auditContainerImage: ${err.message}`);
            process.exit(2);
        }
    }

    let baseline;
    try {
        baseline = loadBaseline(opts.baseline);
    } catch (err) {
        console.error(`auditContainerImage: ${err.message}`);
        process.exit(2);
    }

    const report = evaluate(ev, baseline, opts.profile);
    const md = renderMarkdown(report);

    const mdPath = path.join(opts.out, "container-security-review.md");
    const jsonPath = path.join(opts.out, "container-security-review.json");
    fs.writeFileSync(mdPath, md);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

    if (opts.json) console.log(JSON.stringify(report, null, 2));

    if (!opts.quiet) {
        log("");
        for (const r of report.results) {
            const mark = {pass: "PASS ", fail: "FAIL ", warn: "WARN ", accepted: "ACCPT", info: "INFO ", skip: "SKIP "}[r.status];
            log(`  ${mark} ${r.id}  ${r.title} — ${r.summary}`);
        }
        log("");
        log(`Report:   ${path.relative(PROJECT_ROOT, mdPath)}`);
        log(`Data:     ${path.relative(PROJECT_ROOT, jsonPath)}`);
        if (report.sbomPath) log(`SBOM:     ${report.sbomPath}`);
        log(`Evidence: ${path.relative(PROJECT_ROOT, path.join(opts.out, "evidence"))}/`);
        log("");
        log(`${report.openFindings} open finding(s); worst open severity: ${report.worstOpenSeverity}`);
    }

    if (opts.failOn !== "none") {
        const threshold = severityRank(opts.failOn);
        if (threshold < 0) {
            console.error(`auditContainerImage: --fail-on=${opts.failOn} is not a severity`);
            process.exit(2);
        }
        // A collector that did not complete means the gate did not actually inspect what
        // it claims to gate. Exit non-zero regardless of what the checks concluded: an
        // incomplete review must never read as a clean one.
        if (report.errors.length) {
            console.error(`\nauditContainerImage: ${report.errors.length} collector(s) did not complete, so this review is incomplete:`);
            for (const e of report.errors) console.error(`  - ${e}`);
            process.exit(1);
        }
        const breaching = report.results.filter((r) => OPEN_STATUSES.has(r.status) && severityRank(r.severity) >= threshold);
        if (breaching.length) {
            console.error(`\nauditContainerImage: ${breaching.length} finding(s) at or above ${opts.failOn}: ${breaching.map((b) => b.id).join(", ")}`);
            process.exit(1);
        }
    }
}

// Only run when invoked directly, so tests can import the pure functions.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2));
}
