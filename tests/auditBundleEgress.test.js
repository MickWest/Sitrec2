const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    SKIP_DIRS,
    SKIP_FILES,
    auditDirectory,
    extractHosts,
    hasSourceMapReference,
    isSkipped,
    loadAllowlist,
    loadServerAllowlist,
    auditServerTree,
    validateAllowlist,
    validateServerAllowlist,
} = require("../scripts/auditBundleEgress");

describe("extractHosts", () => {
    test("finds every scheme://host literal, lower-cased and counted", () => {
        const text = [
            'fetch("https://api.example-provider.com/v1/tiles/${z}")',
            "const a = 'HTTP://Api.Example-Provider.COM/other';",
            'xmlns="http://www.w3.org/2000/svg"',
            'see https://github.com/mrdoob/three.js/issues/123',
        ].join("\n");
        const hosts = extractHosts(text);
        expect([...hosts.entries()]).toEqual([
            ["api.example-provider.com", 2],
            ["www.w3.org", 1],
            ["github.com", 1],
        ]);
    });

    test("stops at the host: ports, paths, queries and credentials are not part of it", () => {
        const hosts = extractHosts('https://tiles.example.org:8443/a/b?key=abc#frag http://127.0.0.1:8000/x');
        expect([...hosts.keys()]).toEqual(["tiles.example.org", "127.0.0.1"]);
    });

    test("ignores schemeless and dotless names", () => {
        // A bare host string is caught by the stub map's originalHostLiterals, not here.
        expect(extractHosts('const host = "api.mapbox.com"; http://localhost:3000/').size).toBe(0);
    });

    test("finds hosts inside minified code and JSON", () => {
        const minified = 'e.src="https://cdn.example.net/lib.js",t=JSON.parse(\'{"u":"https://cdn.example.net/x"}\')';
        expect(extractHosts(minified).get("cdn.example.net")).toBe(2);
    });
});

describe("hasSourceMapReference", () => {
    test("detects the comment forms and an inline data map", () => {
        expect(hasSourceMapReference("x;\n//# sourceMappingURL=index.js.map")).toBe(true);
        expect(hasSourceMapReference("/*# sourceMappingURL=style.css.map */")).toBe(true);
        expect(hasSourceMapReference("eval(\"...//# sourceMappingURL=data:application/json;base64,AAAA\")")).toBe(true);
    });

    test("clean code passes", () => {
        expect(hasSourceMapReference("function f(){return 1}")).toBe(false);
    });
});

describe("validateAllowlist", () => {
    const good = { host: "www.w3.org", purpose: "XML namespace identifier; not a request", trigger: "never requested", mayReceive: ["none"] };

    test("accepts a well-formed list and returns the host set", () => {
        expect(validateAllowlist({ hosts: [good] })).toEqual(new Set(["www.w3.org"]));
    });

    test("rejects a wildcard host", () => {
        expect(() => validateAllowlist({ hosts: [{ ...good, host: "*.w3.org" }] })).toThrow(/wildcard/);
    });

    test("rejects an entry that admits to receiving anything", () => {
        expect(() => validateAllowlist({ hosts: [{ ...good, mayReceive: ["coarse-area"] }] })).toThrow(/mayReceive \["none"\]/);
        expect(() => validateAllowlist({ hosts: [{ ...good, mayReceive: [] }] })).toThrow(/mayReceive \["none"\]/);
        expect(() => validateAllowlist({ hosts: [{ ...good, mayReceive: undefined }] })).toThrow(/mayReceive \["none"\]/);
    });

    test("rejects a missing purpose, an upper-case host, a duplicate and a bad shape", () => {
        expect(() => validateAllowlist({ hosts: [{ ...good, purpose: "" }] })).toThrow(/purpose/);
        expect(() => validateAllowlist({ hosts: [{ ...good, host: "WWW.w3.org" }] })).toThrow(/lower case/);
        expect(() => validateAllowlist({ hosts: [good, { ...good }] })).toThrow(/duplicate/);
        expect(() => validateAllowlist({})).toThrow(/"hosts" array/);
        expect(() => validateAllowlist({ hosts: [{ purpose: "x", mayReceive: ["none"] }] })).toThrow(/"host"/);
    });

    test("classes: gated needs a gate, link says what a click carries, inert stays none", () => {
        expect(() => validateAllowlist({ hosts: [{ ...good, class: "gated" }] })).toThrow(/"gate"/);
        expect(() => validateAllowlist({ hosts: [{ ...good, class: "gated", gate: "SOME_RUNTIME_SETTING" }] })).toThrow(/"gate"/);
        expect(validateAllowlist({ hosts: [{ ...good, class: "gated", gate: "isSecureBuild" }] })).toEqual(new Set(["www.w3.org"]));
        expect(validateAllowlist({ hosts: [{ ...good, class: "gated", gate: "SITREC_ENABLE_DEFAULT_MAP_SOURCES=false" }] }))
            .toEqual(new Set(["www.w3.org"]));
        expect(validateAllowlist({ hosts: [{ ...good, class: "link", mayReceive: ["precise-position", "time"] }] }))
            .toEqual(new Set(["www.w3.org"]));
        expect(() => validateAllowlist({ hosts: [{ ...good, class: "link", mayReceive: [] }] })).toThrow(/link/);
        expect(() => validateAllowlist({ hosts: [{ ...good, class: "inert", mayReceive: ["time"] }] })).toThrow(/mayReceive \["none"\]/);
        expect(() => validateAllowlist({ hosts: [{ ...good, class: "fetched" }] })).toThrow(/class/);
        expect(() => validateAllowlist({ hosts: [{ ...good, gate: "x" }] })).toThrow(/not class gated/);
    });

    test("the checked-in secure allow-list is valid", () => {
        expect(loadAllowlist().size).toBeGreaterThan(0);
    });
});

describe("isSkipped", () => {
    test("skips exactly the documented directories and files, at the root only", () => {
        expect(SKIP_DIRS).toEqual(["docs", "tools", "data", "sitrecServer/vendor", "tests"]);
        expect(SKIP_FILES).toEqual(["README.html"]);
        expect(isSkipped("tests/securityScanEgress.test.js")).toBe(true);
        expect(isSkipped("README.html")).toBe(true);
        expect(isSkipped("docs/README.html")).toBe(true);
        expect(isSkipped("install/README.html")).toBe(false);
        expect(isSkipped("tests.js")).toBe(false);
        expect(isSkipped("docs/Foo.html")).toBe(true);
        expect(isSkipped("tools/shf/app.js")).toBe(true);
        expect(isSkipped("data/custom/x.json")).toBe(true);
        expect(isSkipped("sitrecServer/vendor/aws/x.js")).toBe(true);
        expect(isSkipped("sitrecServer/successfullyLoggedIn.html")).toBe(false);
        expect(isSkipped("index.abc.bundle.js")).toBe(false);
        expect(isSkipped("libs/opencv.js")).toBe(false);
        expect(isSkipped("mydocs/x.js")).toBe(false);
    });
});

describe("auditServerTree against the server allow-list", () => {
    let root;
    const entries = () => validateServerAllowlist({ files: [
        { file: "config.php", required: true, mustContain: ["AUTH_MODE", "resolveCertIdentity"], purpose: "seam" },
        { file: "user.php", required: true, purpose: "include" },
        { file: "object.php", purpose: "endpoint" },
        { file: "vendor/", purpose: "libraries" },
    ] });

    function write(relativePath, content) {
        const fullPath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
    }

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "sitrec-server-"));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test("a tree of exactly the listed files, with the seam present, passes", () => {
        write("sitrecServer/config.php", "<?php if ($authMode === 'cert') { require_once __DIR__ . '/auth_cert.php'; resolveCertIdentity($_SERVER, getenv()); } // AUTH_MODE");
        write("sitrecServer/user.php", "<?php");
        write("sitrecServer/vendor/autoload.php", "<?php");
        expect(auditServerTree(root, entries())).toEqual([]);
    });

    test("a config.php without the seam is a finding, as is an extra or a missing file", () => {
        write("sitrecServer/config.php", "<?php // the old file, loopback is administrator");
        write("sitrecServer/user.php", "<?php");
        write("sitrecServer/chatbot.php", "<?php");
        expect(auditServerTree(root, entries())).toEqual([
            { issue: "Server file not in the secure server allow-list", file: "sitrecServer/chatbot.php" },
            { issue: "Server file lacks required content", file: "sitrecServer/config.php", needle: "AUTH_MODE" },
            { issue: "Server file lacks required content", file: "sitrecServer/config.php", needle: "resolveCertIdentity" },
        ]);

        fs.rmSync(path.join(root, "sitrecServer/user.php"));
        fs.rmSync(path.join(root, "sitrecServer/chatbot.php"));
        write("sitrecServer/config.php", "AUTH_MODE resolveCertIdentity");
        expect(auditServerTree(root, entries())).toEqual([
            { issue: "Required server file missing from output", file: "sitrecServer/user.php" },
        ]);
    });

    test("a missing server tree is a finding, and the checked-in server allow-list is valid", () => {
        expect(auditServerTree(root, entries())).toEqual([{ issue: "Server tree missing from output", file: "sitrecServer/" }]);
        const checkedIn = loadServerAllowlist();
        expect(checkedIn.get("config.php").mustContain).toEqual(expect.arrayContaining(["resolveCertIdentity"]));
        expect(checkedIn.get("auth_cert.php").required).toBe(true);
        expect(checkedIn.has("chatbot.php")).toBe(false);
        expect(() => validateServerAllowlist({ files: [{ file: "../x.php", purpose: "p" }] })).toThrow(/plain file/);
        expect(() => validateServerAllowlist({ files: [{ file: "a.php", purpose: "p" }, { file: "a.php", purpose: "p" }] })).toThrow(/duplicate/);
    });
});

describe("auditDirectory on a fixture tree", () => {
    let root;

    function write(relativePath, content) {
        const fullPath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
    }

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "sitrec-egress-"));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test("a clean output passes", () => {
        write("index.abc.bundle.js", 'xmlns="http://www.w3.org/2000/svg"; SECURE_STUB_REHOST;');
        write("index.css", "body{background:url(data:image/png;base64,AAAA)}");
        write("docs/Foo.html", '<a href="https://api.mapbox.com/">provider</a>');           // skipped
        write("tools/x.js", 'fetch("https://api.tomtom.com/")');                            // skipped
        write("data/custom/x.json", '{"src":"https://gibs.earthdata.nasa.gov/"}');           // skipped
        write("sitrecServer/vendor/aws/x.js", 'https://s3.amazonaws.com/');                  // skipped
        write("tests/fixture.test.js", 'https://evil.example/ //# sourceMappingURL=x.map');    // skipped
        write("README.html", '<a href="https://github.com/MickWest/Sitrec2">project</a>');   // skipped
        write("libs/opencv.wasm", "not scanned: not a text extension https://x.y.z/");       // extension not scanned
        const result = auditDirectory(root, {
            allowedHosts: new Set(["www.w3.org"]),
            stubs: { removedMarkers: ["SECURE_STUB_REHOST"], originalHostLiterals: ["api.mapbox.com"] },
        });
        expect(result.findings).toEqual([]);
        expect(result.scanned).toBe(2);
        expect([...result.hosts.keys()]).toEqual(["www.w3.org"]);
    });

    test("a host outside the allow-list is a finding, with file and count", () => {
        write("index.abc.bundle.js", 'a="https://api.tile-provider.example/{z}";b="https://api.tile-provider.example/2"');
        write("sitrecServer/successfullyLoggedIn.html", '<a href="https://api.tile-provider.example/">x</a>');
        const { findings } = auditDirectory(root, { allowedHosts: new Set(["www.w3.org"]) });
        expect(findings).toEqual([{
            issue: "Host not in the secure egress allow-list",
            host: "api.tile-provider.example",
            count: 3,
            files: ["index.abc.bundle.js", "sitrecServer/successfullyLoggedIn.html"],
        }]);
    });

    test("a .map file anywhere and a sourceMappingURL in JS are findings", () => {
        write("index.abc.bundle.js", "x;\n//# sourceMappingURL=index.abc.bundle.js.map");
        write("index.abc.bundle.js.map", "{}");
        write("docs/foo.js.map", "{}");                     // .map is checked even in skipped dirs
        const { findings } = auditDirectory(root, { allowedHosts: new Set() });
        expect(findings.map((f) => f.issue).sort()).toEqual([
            "Source map file in output",
            "Source map file in output",
            "sourceMappingURL in emitted JS",
        ]);
        expect(findings.filter((f) => f.issue === "Source map file in output").map((f) => f.file).sort())
            .toEqual(["docs/foo.js.map", "index.abc.bundle.js.map"]);
    });

    test("--allow-source-maps tolerates the reference but never a .map file", () => {
        write("index.bundle.js", "x;\n//# sourceMappingURL=data:application/json;base64,AAAA");
        expect(auditDirectory(root, { allowedHosts: new Set(), allowSourceMaps: true }).findings).toEqual([]);
        write("index.bundle.js.map", "{}");
        expect(auditDirectory(root, { allowedHosts: new Set(), allowSourceMaps: true }).findings)
            .toEqual([{ issue: "Source map file in output", file: "index.bundle.js.map" }]);
    });

    test("a missing stub marker and a surviving original host literal are findings", () => {
        write("index.abc.bundle.js", 'const host="api.mapbox.com"; SECURE_STUB_CHAT;');
        const { findings } = auditDirectory(root, {
            allowedHosts: new Set(),
            stubs: { removedMarkers: ["SECURE_STUB_CHAT", "SECURE_STUB_REHOST"], originalHostLiterals: ["api.mapbox.com", "celestrak.org"] },
        });
        expect(findings).toEqual([
            { issue: "Stub marker missing from emitted JS (stub did not replace the original)", marker: "SECURE_STUB_REHOST" },
            { issue: "Original host literal survived stubbing", literal: "api.mapbox.com", files: ["index.abc.bundle.js"] },
        ]);
    });

    test("a gated host literal must be matched by a gated allow-list entry", () => {
        write("index.abc.bundle.js", 'if (isSecureBuild) throw e; fetch("https://api.open-meteo.com/v1"); SECURE_STUB_X;');
        const stubs = { removedMarkers: ["SECURE_STUB_X"], originalHostLiterals: [], gatedHostLiterals: ["api.open-meteo.com"] };
        const gated = new Map([["api.open-meteo.com", { host: "api.open-meteo.com", class: "gated", gate: "isSecureBuild", mayReceive: ["none"] }]]);
        expect(auditDirectory(root, { allowedEntries: gated, stubs }).findings).toEqual([]);

        const inert = new Map([["api.open-meteo.com", { host: "api.open-meteo.com", class: "inert", mayReceive: ["none"] }]]);
        expect(auditDirectory(root, { allowedEntries: inert, stubs }).findings).toEqual([
            { issue: "Gated host literal has no gated allow-list entry naming its gate", literal: "api.open-meteo.com", files: ["index.abc.bundle.js"] },
        ]);

        // Without entries (host-set callers) the gate check does not run, but the host itself is a finding.
        const { findings } = auditDirectory(root, { allowedHosts: new Set(), stubs });
        expect(findings.map((finding) => finding.issue)).toEqual(["Host not in the secure egress allow-list"]);
    });

    test("without a stub map the stub checks are skipped", () => {
        write("index.abc.bundle.js", 'const host="api.mapbox.com";');
        expect(auditDirectory(root, { allowedHosts: new Set(), stubs: null }).findings).toEqual([]);
    });

    test("a missing target is an error", () => {
        expect(() => auditDirectory(path.join(root, "nope"), {})).toThrow(/not a directory/);
    });
});
