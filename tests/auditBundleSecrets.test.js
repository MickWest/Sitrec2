const {
    collectConfigLiteralCandidates,
} = require("../scripts/auditBundleSecrets");

describe("collectConfigLiteralCandidates", () => {
    test("returns config literals without exposing placeholders", () => {
        const findings = collectConfigLiteralCandidates();

        expect(Array.isArray(findings)).toBe(true);
        for (const finding of findings) {
            expect(finding.value.includes("${")).toBe(false);
        }
    });
});

// "secure" mode: the secure build (dist-secure) is a server tree, so sitrecServer/ and the
// guarded shared.env.php are expected there - but its client environment is stripped, so
// no credential may appear anywhere else, the two client-public keys included.
describe("secure mode", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { scanFile, SERVER_SHAPED_MODES } = require("../scripts/auditBundleSecrets");
    const MAPBOX_SHAPED = "pk.eyJ" + "A".repeat(30);
    let root;

    function write(relativePath, content) {
        const fullPath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
        return fullPath;
    }

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "sitrec-secrets-"));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test("is server-shaped", () => {
        expect(SERVER_SHAPED_MODES.has("secure")).toBe(true);
        expect(SERVER_SHAPED_MODES.has("bundle")).toBe(false);
    });

    test("sitrecServer/ files are not findings by path, but a credential in one still is", () => {
        const clean = write("sitrecServer/getsitches.php", "<?php echo 'ok';");
        expect(scanFile(clean, [], { mode: "secure", scanRoot: root })).toEqual([]);
        expect(scanFile(clean, [], { mode: "bundle", scanRoot: root }))
            .toEqual([{ file: clean, issue: "Forbidden server/config file bundled" }]);

        const leaky = write("sitrecServer/leak.php", `$k = "${MAPBOX_SHAPED}";`);
        expect(scanFile(leaky, [], { mode: "secure", scanRoot: root }).map((f) => f.issue)).toEqual(["Mapbox token"]);
    });

    test("a client-public token is a finding even when it is the configured value", () => {
        const bundle = write("index.bundle.js", `const t = "${MAPBOX_SHAPED}";`);
        const options = { scanRoot: root, allowedPublicValues: new Set([MAPBOX_SHAPED]) };
        expect(scanFile(bundle, [], { ...options, mode: "server" })).toEqual([]);
        expect(scanFile(bundle, [], { ...options, mode: "secure" }).map((f) => f.issue)).toEqual(["Mapbox token"]);
    });

    test("shared.env.php content is not scanned (its guard is checked instead)", () => {
        const env = write("shared.env.php", `<?php /*;\nMAPBOX_TOKEN=${MAPBOX_SHAPED}\n*/`);
        expect(scanFile(env, [], { mode: "secure", scanRoot: root })).toEqual([]);
    });

    test("known fixtures in the published test tree are tolerated, other credentials are not", () => {
        const fixture = write("tests/BYOKKeyStore.test.js", 'const k = "sk-ant-SUPERSECRET-abcdef123456";');
        expect(scanFile(fixture, [], { mode: "secure", scanRoot: root })).toEqual([]);
        const other = write("tests/other.test.js", 'const k = "sk-' + "b".repeat(30) + '";');
        expect(scanFile(other, [], { mode: "secure", scanRoot: root }).map((f) => f.issue)).toEqual(["OpenAI-style key"]);
    });

    // "sk-" occurs inside ordinary words, so the OpenAI pattern needs a left boundary.
    // Without one, aws-sdk-php's bedrock-agentcore API definition — which contains
    // "task-instruction-category-non-compliance" — aborted a production deploy. Both
    // directions are asserted, because a boundary added carelessly is how a detector
    // stops detecting.
    test("a key must start at a token boundary, but is still found at one", () => {
        const vendor = write("vendor/api-2.json.php", [
            "'task-instruction-category-non-compliance',",
            "'execution-error-category-tool-schema',",
            "'risk-assessment-category-identifier-value',",
        ].join("\n"));
        expect(scanFile(vendor, [], { mode: "server", scanRoot: root })).toEqual([]);

        const real = "sk-live-" + "c".repeat(28);
        for (const line of [`const k = "${real}";`, `KEY=${real}`, `'${real}'`, `[${real}]`]) {
            const f = write(`case-${line.length}-${line[0]}.js`, line);
            expect(scanFile(f, [], { mode: "server", scanRoot: root }).map((x) => x.issue))
                .toEqual(["OpenAI-style key"]);
        }
    });
});
