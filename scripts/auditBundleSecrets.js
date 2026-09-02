const fs = require("fs");
const path = require("path");
const {
    SHARED_ENV_PATH,
    buildServerlessClientEnv,
    isSensitiveEnvKey,
    loadDotenvFile,
} = require("./serverlessClientEnv");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_TARGETS = [path.join(PROJECT_ROOT, "dist-serverless")];
const SECURE_TARGETS = [path.join(PROJECT_ROOT, "dist-secure")];

// Two audits with OPPOSITE expectations, so they are separate modes.
//
// "bundle" (the default) audits a SERVERLESS or DESKTOP build. There, every key is
// stripped to "" by scripts/serverlessClientEnv.js, so nothing sensitive may appear at
// all and a bundled shared.env or sitrecServer/ is itself a finding.
//
// "server" audits a FULL SERVER build - the tree that gets rsynced to production. That
// tree is SUPPOSED to carry sitrecServer/ and shared.env.php, so those are not findings
// here. What must never appear is a credential the browser can fetch.
//
// "secure" audits the SECURE build (webpack.secure.js, dist-secure): a full server tree,
// so sitrecServer/ and the guarded shared.env.php belong there as in server mode - but the
// client environment is stripped like a serverless bundle (scripts/secureClientEnv.js), so
// NO credential may appear anywhere else, the two client-public keys included.
const MODES = ["bundle", "server", "secure"];

// The modes whose target is a server tree: sitrecServer/ and shared.env.php are expected,
// the published tests/ tree carries known fixtures, and the shared.env.php guard is checked.
const SERVER_SHAPED_MODES = new Set(["server", "secure"]);

// The only two keys a full-server build may publish. The browser fetches Mapbox and
// MapTiler tiles DIRECTLY, so those tokens are unavoidably public: the map sources
// declare them as requiredToken, and the build-time map in src/nodes/CNodeTerrainUI.js
// bakes them in. Every other key - Google and Cesium included - reaches the browser only
// through rehost.php?getuser, which gates it on group membership and remaining daily
// quota. One of those appearing anywhere in the served tree silently defeats that gate,
// which is the regression this mode exists to catch.
const CLIENT_PUBLIC_ENV_KEYS = new Set(["MAPBOX_TOKEN", "MAPTILER_KEY"]);

// Written by webpackCopyPatterns.js from config/shared.env, and it holds ALL the keys by
// design. It is not served: the copy prepends "<?php /*;" so a direct request executes it
// as PHP and returns nothing. Its CONTENT is therefore not scanned - the guard is checked
// instead, because a shared.env.php that lost its prefix would serve every key as text.
// A credential sitting in a KNOWN provider URL must be the value configured for that
// provider NOW. This catches what a shape pattern cannot: a MapTiler key is 20 plain
// alphanumerics, indistinguishable from a hash or a minified identifier, so there is no
// safe shape to match on - but anchored to api.maptiler.com it is unambiguous.
//
// A stale value here is a revoked credential shipped to users, which silently breaks the
// imagery it serves. Anchoring also keeps this free of false positives: a URL whose
// credential comes from a runtime variable (`key=${n}`) cannot match, because the capture
// accepts literal characters only.
const PROVIDER_URL_CREDENTIALS = [
    {
        label: "MapTiler key",
        envKey: "MAPTILER_KEY",
        regex: /api\.maptiler\.com[^`"']{0,200}?[?&]key=([A-Za-z0-9_-]{10,})/g,
    },
    {
        label: "Mapbox token",
        envKey: "MAPBOX_TOKEN",
        regex: /api\.mapbox\.com[^`"']{0,200}?[?&]access_token=([A-Za-z0-9._-]{10,})/g,
    },
];

// Documentation and comments show these URLs with a placeholder where the credential
// goes - "YOUR_MAPTILER_KEY", "EXAMPLEKEY" - and docs/ is published, so the provider-URL
// check meets them. A placeholder is not a credential.
//
// Deliberately tight, so it cannot excuse a real key: the value must be ENTIRELY upper
// case, digits, underscore and hyphen AND contain one of these words. Real credentials
// carry mixed case (a Mapbox token starts "pk.eyJ", a MapTiler key is mixed alphanumeric),
// so they cannot satisfy the first half however they are spelled.
const PLACEHOLDER_SHAPE = /^[A-Z0-9_-]+$/;
const PLACEHOLDER_WORDS = /YOUR|EXAMPLE|PLACEHOLDER|DUMMY|FAKE|SAMPLE|CHANGEME|INSERT|TODO/;

function isPlaceholderValue(value) {
    return PLACEHOLDER_SHAPE.test(value) && PLACEHOLDER_WORDS.test(value);
}

// The one literal shared.env.example and config.js.example ship in place of a credential,
// and the value src/ compares against to decide a key is not configured yet (see
// hasRequiredToken in CNodeTerrainUI.js and WaterMaskTiles.js). Because the app carries that
// comparison in its own source, an unconfigured clone searched its build for "EXAMPLEKEY",
// found the check, and failed the audit on itself — so `npm run dev-serverless` could not
// succeed on a fresh checkout.
//
// This is an EXACT match, not isPlaceholderValue(). That test is written for the provider-URL
// scan, where the credential is a Mapbox or MapTiler token and therefore always mixed case, so
// requiring an all-upper-case value cannot excuse a real one. That reasoning does NOT carry to
// the scans below: an AWS access key id is all upper case and alphanumeric, so a real
// S3_ACCESS_KEY_ID that happened to contain "FAKE" or "SAMPLE" would satisfy the heuristic and
// be waved through. One exact string cannot.
const UNSET_CREDENTIAL_SENTINEL = "EXAMPLEKEY";

const SERVER_ENV_FILE = "shared.env.php";
const SERVER_ENV_GUARD = "<?php";

// A full-server build deliberately publishes the test tree, for browser-based benchmarks
// and tests (webpackCopyPatterns.js), so production SERVES these files. Its fixtures use
// realistic-LOOKING credentials as test data, which the shape-based
// GENERIC_SECRET_PATTERNS cannot tell from the real thing.
//
// The tolerance is therefore per-VALUE, not per-directory. Disabling the shape patterns
// under tests/ wholesale would let a real Google, OpenAI, GitHub or Slack key committed
// to a test file ship undetected - exactly the leak this audit exists to stop, and worse
// here because that tree is public. So every fixture is allow-listed by its exact value
// and every other match still fails.
//
// A NEW fixture will fail the audit until it is added here. That is the intended cost:
// it forces a human to confirm the value is not a real credential.
const SERVER_FIXTURE_DIRS = [/^tests\//i];
const SERVER_FIXTURE_ALLOWLIST = new Set([
    "sk-ant-SUPERSECRET-abcdef123456",  // tests/BYOKKeyStore.test.js
    "sk-ant-legacy-plaintext",          // tests/BYOKKeyStore.test.js
]);

const FORBIDDEN_PATH_PATTERNS = [
    /(^|\/)shared\.env(\.php)?$/i,
    /(^|\/)config\.php$/i,
    /(^|\/)sitrecServer(\/|$)/i,
];

const GENERIC_SECRET_PATTERNS = [
    // clientPublic: a full-server build may legitimately publish this one - see
    // CLIENT_PUBLIC_ENV_KEYS. Every other pattern here is forbidden in BOTH modes.
    { label: "Mapbox token", regex: /pk\.eyJ[0-9A-Za-z._-]{20,}/g, clientPublic: true },
    { label: "Google API key", regex: /AIza[0-9A-Za-z_-]{20,}/g },
    // Cesium Ion tokens are JWTs. Without this they are only caught at their EXACT
    // current value, so an OLD one embedded somewhere would pass - and Cesium is
    // server-only, meaning ANY JWT reaching the served output is wrong however stale.
    // Narrow on purpose: all three segments, the first two starting "eyJ" (base64url of
    // '{"'). Measured against the whole production tree, the only match is inside
    // shared.env.php, which server mode does not scan.
    { label: "JWT (Cesium Ion-style token)", regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
    { label: "OpenAI-style key", regex: /sk-[A-Za-z0-9_-]{20,}/g },
    { label: "GitHub token", regex: /ghp_[A-Za-z0-9]{20,}/g },
    { label: "Slack token", regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
];

function maskValue(value) {
    if (!value || value.length <= 8) {
        return "[masked]";
    }

    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function collectEnvSecretCandidates(mode = "bundle") {
    const liveEnv = loadDotenvFile(SHARED_ENV_PATH);
    const candidates = [];

    for (const [key, value] of Object.entries(liveEnv)) {
        const trimmedValue = String(value ?? "").trim();
        if (!trimmedValue || !isSensitiveEnvKey(key)) {
            continue;
        }

        if (trimmedValue === UNSET_CREDENTIAL_SENTINEL) {
            continue;
        }

        // A full-server build is supposed to publish these two.
        if (mode === "server" && CLIENT_PUBLIC_ENV_KEYS.has(key)) {
            continue;
        }

        candidates.push({
            label: `Env ${key}`,
            value: trimmedValue,
        });
    }

    return candidates;
}

function collectConfigLiteralCandidates() {
    const configPath = path.join(PROJECT_ROOT, "config", "config.js");
    if (!fs.existsSync(configPath)) {
        return [];
    }

    const configText = fs.readFileSync(configPath, "utf8");
    const candidates = [];
    const literalPatterns = [
        { label: "Config access_token", regex: /access_token=([A-Za-z0-9._-]{10,})/g },
        { label: "Config query key", regex: /\bkey=([A-Za-z0-9._-]{10,})/g },
        { label: "Config Mapbox token", regex: /(pk\.eyJ[0-9A-Za-z._-]{20,})/g },
    ];

    for (const { label, regex } of literalPatterns) {
        let match;
        while ((match = regex.exec(configText)) !== null) {
            const value = match[1];
            if (!value || value.includes("${")) {
                continue;
            }

            if (value === UNSET_CREDENTIAL_SENTINEL) {
                continue;
            }

            candidates.push({ label, value });
        }
    }

    return candidates;
}

function dedupeCandidates(candidates) {
    const seen = new Set();
    return candidates.filter(({ label, value }) => {
        const key = `${label}:${value}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function expandScanRoots(targetPath) {
    const resolved = path.resolve(targetPath);

    if (!fs.existsSync(resolved)) {
        throw new Error(`Scan target does not exist: ${resolved}`);
    }

    if (resolved.endsWith(".app")) {
        return [path.join(resolved, "Contents", "Resources")];
    }

    return [resolved];
}

function shouldSkipPath(filePath) {
    return filePath.includes(`${path.sep}sitrec-terrain${path.sep}`)
        || filePath.includes(`${path.sep}Frameworks${path.sep}`);
}

function walkFiles(rootPath, files = []) {
    if (!fs.existsSync(rootPath)) {
        return files;
    }

    const stat = fs.statSync(rootPath);
    if (stat.isFile()) {
        if (!shouldSkipPath(rootPath)) {
            files.push(rootPath);
        }
        return files;
    }

    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
        const fullPath = path.join(rootPath, entry.name);
        if (shouldSkipPath(fullPath)) {
            continue;
        }

        if (entry.isDirectory()) {
            walkFiles(fullPath, files);
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }

    return files;
}

function scanFile(filePath, secretCandidates, options = {}) {
    const {
        mode = "bundle",
        scanRoot,
        allowedPublicValues = new Set(),
        configuredEnv = {},
    } = options;
    const findings = [];
    const normalizedPath = filePath.split(path.sep).join("/");

    // Relative to the scanned root, so a prod_path that happens to contain "tests"
    // somewhere in its own path cannot exempt the whole build.
    const relativePath = scanRoot
        ? path.relative(scanRoot, filePath).split(path.sep).join("/")
        : normalizedPath;
    const inFixtureTree = SERVER_SHAPED_MODES.has(mode)
        && SERVER_FIXTURE_DIRS.some((pattern) => pattern.test(relativePath));

    // A full-server tree is MEANT to contain sitrecServer/ and shared.env.php, so their
    // presence is not a finding there - only their contents leaking would be.
    if (!SERVER_SHAPED_MODES.has(mode)) {
        for (const pattern of FORBIDDEN_PATH_PATTERNS) {
            if (pattern.test(normalizedPath)) {
                findings.push({
                    file: filePath,
                    issue: "Forbidden server/config file bundled",
                });
                return findings;
            }
        }
    }

    // shared.env.php holds every key by design; checkServerEnvGuard verifies the one
    // thing that actually protects it instead.
    if (SERVER_SHAPED_MODES.has(mode) && normalizedPath.endsWith(`/${SERVER_ENV_FILE}`)) {
        return findings;
    }

    const buffer = fs.readFileSync(filePath);
    const text = buffer.toString("utf8");

    for (const { label, regex, clientPublic } of GENERIC_SECRET_PATTERNS) {
        regex.lastIndex = 0;
        let unexplained = text.match(regex) ?? [];

        // In the published test tree, drop only the values known to be fixtures. Anything
        // else that looks like a credential is still a finding.
        if (inFixtureTree) {
            unexplained = unexplained.filter((match) => !SERVER_FIXTURE_ALLOWLIST.has(match));
        }

        // A full-server build may publish a client-public token - but ONLY the one that is
        // configured NOW. A token of the same shape with a different value is a stale
        // credential baked into the build, which is precisely what a rotation that missed
        // a second copy of the token leaves behind. That must still fail: the stale value
        // is revoked, so the feature it serves is silently broken in production.
        if (mode === "server" && clientPublic) {
            const stale = unexplained.filter((match) => !allowedPublicValues.has(match));
            if (stale.length > 0) {
                findings.push({
                    file: filePath,
                    issue: `${label} that is NOT the currently configured value (stale credential: ${maskValue(stale[0])})`,
                });
            }
            continue;
        }

        if (unexplained.length > 0) {
            findings.push({
                file: filePath,
                issue: label,
            });
        }
    }

    // Anchored to a provider URL, so this can be exact rather than shape-based.
    for (const { label, envKey, regex } of PROVIDER_URL_CREDENTIALS) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const found = match[1];
            if (isPlaceholderValue(found)) {
                continue;
            }

            const configured = String(configuredEnv[envKey] ?? "").trim();

            // In a serverless or desktop build the key is stripped, so ANY literal here is
            // a leak. In a server build the credential belongs there - but only the
            // current one; anything else is a stale credential being published.
            const wrong = mode === "server" ? found !== configured : true;

            if (wrong && !(inFixtureTree && SERVER_FIXTURE_ALLOWLIST.has(found))) {
                findings.push({
                    file: filePath,
                    issue: mode === "server"
                        ? `${label} in a ${envKey.split("_")[0].toLowerCase()} URL is NOT the currently configured value (stale credential: ${maskValue(found)})`
                        : `${label} literal in a provider URL (${maskValue(found)})`,
                });
            }
        }
    }

    for (const { label, value } of secretCandidates) {
        if (buffer.includes(Buffer.from(value))) {
            findings.push({
                file: filePath,
                issue: `${label} (${maskValue(value)})`,
            });
        }
    }

    return findings;
}

// shared.env.php is excluded from the content scan, so its single protection is checked
// directly: the "<?php" prefix webpackCopyPatterns.js prepends. With it, a direct web
// request executes the file and returns nothing. Without it, the web server would serve
// every key in it as plain text.
function checkServerEnvGuard(scanRoot) {
    const envPath = path.join(scanRoot, SERVER_ENV_FILE);
    if (!fs.existsSync(envPath)) {
        // A build without one has nothing to protect - the serverless builds omit it.
        return [];
    }

    const head = fs.readFileSync(envPath, "utf8").slice(0, SERVER_ENV_GUARD.length);
    if (head === SERVER_ENV_GUARD) {
        return [];
    }

    return [{
        file: envPath,
        issue: `Unprotected ${SERVER_ENV_FILE}: missing the "${SERVER_ENV_GUARD}" prefix, so it would be served as plain text`,
    }];
}

function auditTargets(targets, options = {}) {
    const { mode = "bundle" } = options;

    let secretCandidates = dedupeCandidates([
        ...collectEnvSecretCandidates(mode),
        ...collectConfigLiteralCandidates(),
    ]);

    const liveEnv = loadDotenvFile(SHARED_ENV_PATH);

    // The values a full-server build is allowed to publish, read fresh from config.
    const publicValues = new Set(
        mode === "server"
            ? Object.entries(liveEnv)
                .filter(([key]) => CLIENT_PUBLIC_ENV_KEYS.has(key))
                .map(([, value]) => String(value ?? "").trim())
                .filter(Boolean)
            : [],
    );

    if (mode === "server") {
        // collectConfigLiteralCandidates reads config/config.js, which can name the same
        // two public tokens as literals. Drop candidates BY VALUE so a client-public key
        // is allowed no matter which collector found it.
        secretCandidates = secretCandidates.filter(({ value }) => !publicValues.has(value));
    }

    const findings = [];

    for (const target of targets) {
        for (const scanRoot of expandScanRoots(target)) {
            if (SERVER_SHAPED_MODES.has(mode)) {
                findings.push(...checkServerEnvGuard(scanRoot));
            }

            for (const filePath of walkFiles(scanRoot)) {
                findings.push(...scanFile(filePath, secretCandidates, {
                    mode,
                    scanRoot,
                    allowedPublicValues: publicValues,
                    configuredEnv: liveEnv,
                }));
            }
        }
    }

    return findings;
}

// The production build path is machine-specific: prod_path in config/config-install.js
// (gitignored - a fresh clone has only the .example), or SITREC_PROD_PATH when building
// for another deployment. Resolved lazily so this script still runs everywhere else.
function resolveConfiguredProdPath() {
    const prodPath = require("./buildTarget").prodPath();
    return prodPath ? [prodPath] : [];
}

function main() {
    const args = process.argv.slice(2);
    let mode = "bundle";
    const targets = [];

    for (const arg of args) {
        const matched = /^--mode=(.+)$/.exec(arg);
        if (matched) {
            mode = matched[1];
        } else {
            targets.push(arg);
        }
    }

    if (!MODES.includes(mode)) {
        console.error(`Unknown --mode=${mode}. Expected one of: ${MODES.join(", ")}`);
        process.exit(1);
    }

    let scanTargets = targets;
    if (scanTargets.length === 0) {
        scanTargets = mode === "server" ? resolveConfiguredProdPath()
            : mode === "secure" ? SECURE_TARGETS
            : DEFAULT_TARGETS;
    }

    if (scanTargets.length === 0) {
        // Only reachable in server mode, on a checkout with no configured prod path.
        // Nothing was built to that path either, so there is nothing to audit.
        console.log("Secret audit skipped: no prod_path in config/config-install.js and no SITREC_PROD_PATH.");
        return;
    }

    const findings = auditTargets(scanTargets, { mode });

    if (findings.length > 0) {
        console.error("Secret audit failed.");
        for (const finding of findings) {
            console.error(`- ${finding.issue}: ${finding.file}`);
        }
        process.exit(1);
    }

    if (mode === "server") {
        console.log(
            `Secret audit passed (server mode) for ${scanTargets.length} target(s). Publishable keys: ${[...CLIENT_PUBLIC_ENV_KEYS].join(", ")}.`,
        );
        return;
    }

    if (mode === "secure") {
        console.log(
            `Secret audit passed (secure mode) for ${scanTargets.length} target(s): server tree accepted, no credential anywhere else.`,
        );
        return;
    }

    const sanitizedEnv = buildServerlessClientEnv();
    console.log(
        `Secret audit passed for ${scanTargets.length} target(s). Sanitized ${Object.keys(sanitizedEnv).length} client env values.`,
    );
}

if (require.main === module) {
    main();
}

module.exports = {
    auditTargets,
    checkServerEnvGuard,
    collectConfigLiteralCandidates,
    isPlaceholderValue,
    collectEnvSecretCandidates,
    scanFile,
    CLIENT_PUBLIC_ENV_KEYS,
    SERVER_SHAPED_MODES,
};
