#!/usr/bin/env node

/**
 * Egress tripwire for the secure build's output (dist-secure).
 *
 *   node scripts/auditBundleEgress.js [dir] [--allowlist=<file>] [--allow-source-maps] [--list-hosts]
 *
 * The secure build (webpack.secure.js) is a production server build with every outbound
 * feature removed at compile time. This audit checks the ARTIFACT, not the source: it
 * reads every emitted .js, .mjs, .html, .css and .json file, extracts every "http://host"
 * and "https://host" literal, and fails if a host is not named in
 * scripts/secure-egress-allowlist.json.
 *
 * Every allow-list entry says, honestly, why the literal is in the output, through its
 * "class":
 *   inert  (the default) - never a request: an XML namespace identifier, an issue or
 *            documentation link inside library code, a display string, a pattern used to
 *            recognise a pasted URL. Must declare mayReceive ["none"].
 *   link   - a navigation the USER starts by clicking a menu entry; the page itself never
 *            fetches it. Declares what such a click carries in mayReceive (for example
 *            "precise-position"), so the disclosure is written down, not hidden.
 *   gated  - fetch code is present but sits on a path closed at compile time; "gate" names
 *            the control (isSecureBuild, or a setting forced off by scripts/secureClientEnv.js).
 *            Must declare mayReceive ["none"], because with the gate closed nothing is sent.
 * A host the application would actually contact at run time is never an entry of any class;
 * it is a finding, and the fix is to remove the code that names it (scripts/secureStubs.js).
 * The gatedHostLiterals list in that file must be matched by gated entries here, so a gate
 * that is removed from the code shows up as a failed audit, not as silent egress.
 *
 * Also fails on:
 *   - any .map file anywhere in the output, and any "sourceMappingURL=" in emitted JS
 *     (a source map republishes the unminified source, comments and all);
 *   - a stub marker from scripts/secureStubs.js (removedMarkers) that does not appear in
 *     the emitted JS, which means the stub did not replace the original;
 *   - an originalHostLiterals entry from the same file that does appear anywhere scanned.
 *   Both stub checks are skipped, with a warning, while that map file does not exist.
 *
 * Skipped for host literals: docs/ and README.html (rendered documentation, links by
 * nature), tools/ (the standalone tool pages, outside the application bundle), data/
 * (built-in situations and their source attributions), sitrecServer/vendor/ (server-side
 * library code), and tests/ (the published test tree: fixture strings, never executed by
 * the application - whether the secure artifact should ship it at all is decided with the
 * server endpoint allow-list, see docs/dev/Secure-Build.md). The .map check walks
 * everything.
 *
 * --allow-source-maps is for the debug variant (npm run build-secure-debug), which is
 * built with eval source maps on purpose and is never the deployed artifact.
 */

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_TARGET = path.join(PROJECT_ROOT, "dist-secure");
const DEFAULT_ALLOWLIST_PATH = path.join(__dirname, "secure-egress-allowlist.json");
const STUB_MAP_PATH = path.join(__dirname, "secureStubs.js");

const SKIP_DIRS = ["docs", "tools", "data", "sitrecServer/vendor", "tests"];
// The rendered root README, emitted next to docs/ by the same documentation plugin.
const SKIP_FILES = ["README.html"];
const SCAN_EXTENSIONS = new Set([".js", ".mjs", ".html", ".css", ".json"]);
const JS_EXTENSIONS = new Set([".js", ".mjs"]);

// A scheme followed by a dotted host name. Deliberately the same shape the per-push
// egress scanner uses (scripts/security-scan-egress.mjs), so the two agree on what a
// host literal is. Case-insensitive; hosts are reported in lower case.
const HOST_RE = /https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
const SOURCE_MAP_RE = /sourceMappingURL=/;
const SAMPLE_FILES = 5;

function toPosix(relativePath) {
    return relativePath.split(path.sep).join("/");
}

// host -> count, for one text.
function extractHosts(text) {
    const counts = new Map();
    for (const match of text.matchAll(HOST_RE)) {
        const host = match[1].toLowerCase();
        counts.set(host, (counts.get(host) || 0) + 1);
    }
    return counts;
}

function hasSourceMapReference(text) {
    return SOURCE_MAP_RE.test(text);
}

const ENTRY_CLASSES = new Set(["inert", "link", "gated"]);

// The only gates that exist: the compile-time build flag (src/configUtils.js isSecureBuild)
// and the settings the secure build forces to "false" (scripts/secureClientEnv.js), which
// the runtime ratchet in src/envUtils.js refuses to loosen. Anything else is not a gate.
const KNOWN_GATES = new Set([
    "isSecureBuild",
    ...require("./secureClientEnv").SECURE_SECURITY_FLAGS.map((flag) => `${flag}=false`),
]);

// Validates as it loads and returns host -> entry. Every entry must be an exact host with a
// stated purpose: no wildcards (an escape hatch in a tripwire). An inert or gated entry must
// declare mayReceive ["none"]; a link entry must say what a click carries; a gated entry
// must name its gate. See the header for the classes.
function validateAllowlistEntries(allowlist, label = "allow-list") {
    if (!allowlist || !Array.isArray(allowlist.hosts)) {
        throw new Error(`${label}: expected an object with a "hosts" array`);
    }
    const entries = new Map();
    allowlist.hosts.forEach((entry, index) => {
        const where = `${label} hosts[${index}]`;
        if (!entry || typeof entry.host !== "string" || entry.host.trim() === "") {
            throw new Error(`${where}: "host" must be a non-empty string`);
        }
        const host = entry.host.trim();
        if (host.includes("*")) {
            throw new Error(`${where}: wildcard hosts are not accepted (${host}); list each host exactly`);
        }
        if (host !== host.toLowerCase()) {
            throw new Error(`${where}: host must be lower case (${host})`);
        }
        if (typeof entry.purpose !== "string" || entry.purpose.trim() === "") {
            throw new Error(`${where}: "${host}" needs a "purpose" saying why the literal is in the output`);
        }
        const entryClass = entry.class === undefined ? "inert" : entry.class;
        if (!ENTRY_CLASSES.has(entryClass)) {
            throw new Error(`${where}: "${host}" has an unknown class ${JSON.stringify(entry.class)}; use inert, link or gated`);
        }
        if (entryClass === "gated") {
            if (typeof entry.gate !== "string" || !KNOWN_GATES.has(entry.gate.trim())) {
                throw new Error(`${where}: "${host}" is gated and needs a "gate" naming a compile-time control: isSecureBuild, or one of ${[...KNOWN_GATES].filter((g) => g !== "isSecureBuild").join(", ")}`);
            }
        } else if (entry.gate !== undefined) {
            throw new Error(`${where}: "${host}" carries a "gate" but is not class gated`);
        }
        if (entryClass === "link") {
            const ok = Array.isArray(entry.mayReceive) && entry.mayReceive.length > 0
                && entry.mayReceive.every((item) => typeof item === "string" && item.trim() !== "");
            if (!ok) {
                throw new Error(`${where}: "${host}" is a link and must state in mayReceive what a click carries (or ["none"])`);
            }
        } else if (!Array.isArray(entry.mayReceive) || entry.mayReceive.length !== 1 || entry.mayReceive[0] !== "none") {
            throw new Error(`${where}: "${host}" must declare mayReceive ["none"]; a host that receives anything is a finding, not an entry (or a link, if only a click sends it)`);
        }
        if (entries.has(host)) {
            throw new Error(`${where}: duplicate host ${host}`);
        }
        entries.set(host, { ...entry, host, class: entryClass });
    });
    return entries;
}

// The host set, for callers that only need membership.
function validateAllowlist(allowlist, label = "allow-list") {
    return new Set(validateAllowlistEntries(allowlist, label).keys());
}

function loadAllowlistEntries(filePath = DEFAULT_ALLOWLIST_PATH) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Allow-list not found: ${filePath}`);
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return validateAllowlistEntries(parsed, path.relative(PROJECT_ROOT, filePath));
}

function loadAllowlist(filePath = DEFAULT_ALLOWLIST_PATH) {
    return new Set(loadAllowlistEntries(filePath).keys());
}

// null when the map does not exist (the stub checks are then skipped with a warning).
function loadStubMap(mapPath = STUB_MAP_PATH) {
    if (!fs.existsSync(mapPath)) {
        return null;
    }
    const stubs = require(mapPath);
    return {
        removedMarkers: Array.isArray(stubs.removedMarkers) ? stubs.removedMarkers : [],
        originalHostLiterals: Array.isArray(stubs.originalHostLiterals) ? stubs.originalHostLiterals : [],
        gatedHostLiterals: Array.isArray(stubs.gatedHostLiterals) ? stubs.gatedHostLiterals : [],
    };
}

function isSkipped(relativePath) {
    return SKIP_FILES.includes(relativePath)
        || SKIP_DIRS.some((dir) => relativePath === dir || relativePath.startsWith(`${dir}/`));
}

function walkFiles(root, dir = root, files = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkFiles(root, fullPath, files);
        } else if (entry.isFile()) {
            files.push({ fullPath, relativePath: toPosix(path.relative(root, fullPath)) });
        }
    }
    return files;
}

function auditDirectory(root, options = {}) {
    const {
        allowedEntries = null,           // host -> allow-list entry, when the caller has the classes
        allowSourceMaps = false,
        stubs = null,
    } = options;
    const allowedHosts = options.allowedHosts || (allowedEntries ? new Set(allowedEntries.keys()) : new Set());

    const resolvedRoot = path.resolve(root);
    if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
        throw new Error(`Audit target is not a directory: ${resolvedRoot}`);
    }

    const findings = [];
    const hosts = new Map();           // host -> { count, files: Map<relativePath, count> }
    const literalHits = new Map();     // originalHostLiteral -> Set<relativePath>
    const gatedHits = new Map();       // gatedHostLiteral -> Set<relativePath>
    const markerHits = new Set();      // removedMarkers found
    let scanned = 0;

    for (const { fullPath, relativePath } of walkFiles(resolvedRoot)) {
        const ext = path.extname(relativePath).toLowerCase();

        if (ext === ".map") {
            findings.push({ issue: "Source map file in output", file: relativePath });
            continue;
        }
        if (isSkipped(relativePath) || !SCAN_EXTENSIONS.has(ext)) {
            continue;
        }

        const text = fs.readFileSync(fullPath, "utf8");
        scanned += 1;

        if (JS_EXTENSIONS.has(ext) && !allowSourceMaps && hasSourceMapReference(text)) {
            findings.push({ issue: "sourceMappingURL in emitted JS", file: relativePath });
        }

        for (const [host, count] of extractHosts(text)) {
            const record = hosts.get(host) || { count: 0, files: new Map() };
            record.count += count;
            record.files.set(relativePath, count);
            hosts.set(host, record);
        }

        if (stubs) {
            if (JS_EXTENSIONS.has(ext)) {
                for (const marker of stubs.removedMarkers) {
                    if (text.includes(marker)) markerHits.add(marker);
                }
            }
            for (const literal of stubs.originalHostLiterals) {
                if (text.includes(literal)) {
                    if (!literalHits.has(literal)) literalHits.set(literal, new Set());
                    literalHits.get(literal).add(relativePath);
                }
            }
            for (const literal of stubs.gatedHostLiterals || []) {
                if (text.includes(literal)) {
                    if (!gatedHits.has(literal)) gatedHits.set(literal, new Set());
                    gatedHits.get(literal).add(relativePath);
                }
            }
        }
    }

    for (const [host, record] of [...hosts].sort(([a], [b]) => a.localeCompare(b))) {
        if (!allowedHosts.has(host)) {
            findings.push({
                issue: "Host not in the secure egress allow-list",
                host,
                count: record.count,
                files: [...record.files.keys()],
            });
        }
    }

    if (stubs) {
        for (const marker of stubs.removedMarkers) {
            if (!markerHits.has(marker)) {
                findings.push({ issue: "Stub marker missing from emitted JS (stub did not replace the original)", marker });
            }
        }
        for (const [literal, files] of literalHits) {
            findings.push({ issue: "Original host literal survived stubbing", literal, files: [...files] });
        }
        // A gated literal is expected in the output, but only under an allow-list entry that
        // says so and names the gate. Checked only when the caller supplied the entries.
        if (allowedEntries) {
            for (const [literal, files] of gatedHits) {
                const entry = allowedEntries.get(literal);
                if (!entry || entry.class !== "gated") {
                    findings.push({ issue: "Gated host literal has no gated allow-list entry naming its gate", literal, files: [...files] });
                }
            }
        }
    }

    return { findings, hosts, scanned };
}

// The server files the secure artifact may ship: scripts/secure-server-allowlist.json.
const DEFAULT_SERVER_ALLOWLIST_PATH = path.join(__dirname, "secure-server-allowlist.json");

function validateServerAllowlist(allowlist, label = "server allow-list") {
    if (!allowlist || !Array.isArray(allowlist.files)) {
        throw new Error(`${label}: expected an object with a "files" array`);
    }
    const entries = new Map();
    allowlist.files.forEach((entry, index) => {
        const where = `${label} files[${index}]`;
        if (!entry || typeof entry.file !== "string" || entry.file.trim() === "" || entry.file.includes("*") || entry.file.includes("..")) {
            throw new Error(`${where}: "file" must be a plain file or directory name`);
        }
        if (typeof entry.purpose !== "string" || entry.purpose.trim() === "") {
            throw new Error(`${where}: "${entry.file}" needs a "purpose"`);
        }
        if (entry.mustContain !== undefined && (!Array.isArray(entry.mustContain) || entry.mustContain.some((s) => typeof s !== "string" || s === ""))) {
            throw new Error(`${where}: "${entry.file}" mustContain must be an array of non-empty strings`);
        }
        const name = entry.file.replace(/\/$/, "");
        if (entries.has(name)) {
            throw new Error(`${where}: duplicate file ${name}`);
        }
        entries.set(name, { ...entry, file: name, isDirectory: entry.file.endsWith("/") });
    });
    return entries;
}

function loadServerAllowlist(filePath = DEFAULT_SERVER_ALLOWLIST_PATH) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Server allow-list not found: ${filePath}`);
    }
    return validateServerAllowlist(JSON.parse(fs.readFileSync(filePath, "utf8")), path.relative(PROJECT_ROOT, filePath));
}

// Checks <root>/sitrecServer against the server allow-list: no file outside it, every
// required file present, and every mustContain string present in its file (for config.php,
// that is the client certificate authentication seam - a checkout's own config.php would
// silently replace it otherwise). Directory entries (vendor/) are accepted whole.
function auditServerTree(root, serverEntries) {
    const findings = [];
    const serverDir = path.join(path.resolve(root), "sitrecServer");
    if (!fs.existsSync(serverDir) || !fs.statSync(serverDir).isDirectory()) {
        findings.push({ issue: "Server tree missing from output", file: "sitrecServer/" });
        return findings;
    }
    const present = new Set();
    for (const entry of fs.readdirSync(serverDir, { withFileTypes: true })) {
        present.add(entry.name);
        const allowed = serverEntries.get(entry.name);
        if (!allowed) {
            findings.push({ issue: "Server file not in the secure server allow-list", file: `sitrecServer/${entry.name}` });
            continue;
        }
        if (allowed.isDirectory !== entry.isDirectory()) {
            findings.push({ issue: "Server entry kind differs from the allow-list (file vs directory)", file: `sitrecServer/${entry.name}` });
            continue;
        }
        if (!entry.isDirectory() && allowed.mustContain) {
            const text = fs.readFileSync(path.join(serverDir, entry.name), "utf8");
            for (const needle of allowed.mustContain) {
                if (!text.includes(needle)) {
                    findings.push({ issue: "Server file lacks required content", file: `sitrecServer/${entry.name}`, needle });
                }
            }
        }
    }
    for (const [name, allowed] of serverEntries) {
        if (allowed.required && !present.has(name)) {
            findings.push({ issue: "Required server file missing from output", file: `sitrecServer/${name}` });
        }
    }
    return findings;
}

function formatFinding(finding) {
    if (finding.needle !== undefined) {
        return `${finding.issue}: ${finding.file} does not contain ${JSON.stringify(finding.needle)}`;
    }
    if (finding.host) {
        const sample = finding.files.slice(0, SAMPLE_FILES).join(", ");
        const more = finding.files.length > SAMPLE_FILES ? `, +${finding.files.length - SAMPLE_FILES} more` : "";
        return `${finding.issue}: ${finding.host} (${finding.count}x in ${sample}${more})`;
    }
    if (finding.marker !== undefined) {
        return `${finding.issue}: ${JSON.stringify(finding.marker)}`;
    }
    if (finding.literal !== undefined) {
        return `${finding.issue}: ${JSON.stringify(finding.literal)} in ${finding.files.join(", ")}`;
    }
    return `${finding.issue}: ${finding.file}`;
}

function parseArgs(argv) {
    const options = { target: DEFAULT_TARGET, allowlistPath: DEFAULT_ALLOWLIST_PATH, allowSourceMaps: false, listHosts: false };
    for (const arg of argv) {
        const allowlist = /^--allowlist=(.+)$/.exec(arg);
        if (allowlist) {
            options.allowlistPath = path.resolve(allowlist[1]);
        } else if (arg === "--allow-source-maps") {
            options.allowSourceMaps = true;
        } else if (arg === "--list-hosts") {
            options.listHosts = true;
        } else if (arg.startsWith("--")) {
            throw new Error(`Unknown option ${arg}`);
        } else {
            options.target = path.resolve(arg);
        }
    }
    return options;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const allowedEntries = loadAllowlistEntries(options.allowlistPath);
    const allowedHosts = new Set(allowedEntries.keys());
    const stubs = loadStubMap();
    if (!stubs) {
        console.warn(`Egress audit: ${path.relative(PROJECT_ROOT, STUB_MAP_PATH)} not found - the stub marker and original-host checks are skipped.`);
    }
    if (options.allowSourceMaps) {
        console.warn("Egress audit: source maps allowed (--allow-source-maps); this output is not a deployable artifact.");
    }

    const { findings, hosts, scanned } = auditDirectory(options.target, {
        allowedEntries,
        allowSourceMaps: options.allowSourceMaps,
        stubs,
    });
    findings.push(...auditServerTree(options.target, loadServerAllowlist()));

    if (options.listHosts) {
        for (const [host, record] of [...hosts].sort(([a], [b]) => a.localeCompare(b))) {
            const entry = allowedEntries.get(host);
            const flag = entry ? entry.class : "NOT ALLOWED";
            console.log(`${host}\t${record.count}\t${flag}\t${[...record.files.keys()].slice(0, SAMPLE_FILES).join(", ")}`);
        }
    }

    if (findings.length > 0) {
        console.error(`Egress audit failed for ${path.relative(PROJECT_ROOT, options.target) || "."}: ${findings.length} finding(s).`);
        for (const finding of findings) {
            console.error(`- ${formatFinding(finding)}`);
        }
        console.error("A host the application would contact at run time is never an allow-list entry: remove the code that names it (scripts/secureStubs.js). A literal that is never fetched is classified in scripts/secure-egress-allowlist.json as inert, link (saying what a click carries) or gated (naming the compile-time control).");
        process.exit(1);
    }

    // The classes of what was found, so the artifact's disclosure surface is stated on every
    // passing run, not only when something fails.
    const byClass = { inert: [], link: [], gated: [] };
    for (const host of hosts.keys()) {
        const entry = allowedEntries.get(host);
        if (entry) byClass[entry.class].push(entry);
    }
    console.log(`Egress audit passed for ${path.relative(PROJECT_ROOT, options.target) || "."}: ${scanned} file(s) scanned, ${hosts.size} distinct host literal(s): ${byClass.inert.length} inert, ${byClass.gated.length} gated, ${byClass.link.length} link.`);
    for (const entry of byClass.gated) {
        console.log(`  gated  ${entry.host}  (closed by ${entry.gate})`);
    }
    for (const entry of byClass.link) {
        console.log(`  link   ${entry.host}  (a click may carry: ${entry.mayReceive.join(", ")})`);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    DEFAULT_ALLOWLIST_PATH,
    SKIP_DIRS,
    SKIP_FILES,
    auditDirectory,
    extractHosts,
    hasSourceMapReference,
    isSkipped,
    loadAllowlist,
    loadAllowlistEntries,
    loadServerAllowlist,
    loadStubMap,
    auditServerTree,
    validateAllowlist,
    validateAllowlistEntries,
    validateServerAllowlist,
};
