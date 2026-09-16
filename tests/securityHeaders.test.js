// Baseline response headers are set in four places, and nothing but this file keeps
// them in step: the Apache conf the container installs, the Dockerfile lines that
// make that conf live, and the two Express servers this project ships.
//
// The failure mode that motivates the Dockerfile assertions is specific. A conf
// dropped into conf-available does nothing until a2enconf enables it, and a
// `Header` directive does nothing at all unless mod_headers is loaded — which
// php:8.4-apache does not do by default. Either omission leaves a file that reads
// exactly like a working control and sets no header.
//
// Nothing here starts a server; these are static assertions about shipped files.
// The runtime proof belongs in the container smoke test.

import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// The set every served response must carry. Deliberately small: each of these is
// safe on any deployment. Anything needing an operator's decision (CSP, HSTS,
// X-Frame-Options, Permissions-Policy) is documented, not shipped — see
// docs/dev/SecurityHeaders.md.
const BASELINE = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
};

describe("the container sets the baseline headers", () => {
    const conf = read("docker", "security-headers.conf");
    const dockerfile = read("Dockerfile.release");

    test.each(Object.entries(BASELINE))("Apache sets %s", (header, value) => {
        // `always` is required: without it Apache attaches the header only to
        // 2xx/3xx, omitting exactly the error responses where sniffing matters.
        expect(conf).toMatch(new RegExp(`Header\\s+always\\s+set\\s+${header}\\s+"${value}"`));
    });

    test("mod_headers is enabled, or every directive above is inert", () => {
        expect(dockerfile).toMatch(/a2enmod\s+headers/);
    });

    test("the conf is installed AND enabled", () => {
        expect(dockerfile).toMatch(/COPY\s+docker\/security-headers\.conf\s+\/etc\/apache2\/conf-available\//);
        expect(dockerfile).toMatch(/a2enconf\s+sitrec-security-headers/);
    });
});

describe("the container sets cache headers by file name", () => {
    const conf = read("docker", "cache-headers.conf");
    const dockerfile = read("Dockerfile.release");

    // The two Apache expressions, in order: the immutable branch, then no-cache.
    const [immutable, noCache] = [...conf.matchAll(/<(?:Else)?If "%\{REQUEST_FILENAME\} =~ m#(.+)#">/g)]
        .map(m => new RegExp(m[1]));
    const root = name => "/var/www/html/" + name;

    test("the conf is installed AND enabled", () => {
        expect(dockerfile).toMatch(/COPY\s+docker\/cache-headers\.conf\s+\/etc\/apache2\/conf-available\//);
        expect(dockerfile).toMatch(/a2enconf\s+sitrec-cache-headers/);
    });

    test("each branch sets the intended header", () => {
        expect(conf).toMatch(/<If [^>]+>\s*Header set Cache-Control "public, max-age=31536000, immutable"\s*<\/If>/);
        expect(conf).toMatch(/<ElseIf [^>]+>\s*Header set Cache-Control "no-cache"\s*<\/ElseIf>/);
    });

    // Names taken from a production build.
    test.each([
        "bootstrap.beacfc8a97c4825cb3dd.bundle.js",
        "index.07cadf6ad9834d5efa9c.bundle.js",
        "vendors-node_modules_astronomy-engine_esm_astronomy_js-node_modules_satellite_js_dist_satelli-384e5e.68da8f033277b10ceae0.bundle.js",
        "8a5d575186451cae1e2a.js",
        "8e17072deeb50510e590.wasm",
        "refraction-tool.d392446e.css",
    ])("hashed %s is cached for a year", name => {
        expect(immutable.test(root(name))).toBe(true);
    });

    // A fixed name changes under the same URL, so a year-long cache would serve a
    // stale copy. Uploads are below the web root and are never matched.
    test.each([
        "index.html",
        "index.css",
        "app-entry.json",
        "bootstrap.bundle.js",
        "index.07cadf6ad9834d5efa9c.bundle.js.LICENSE.txt",
        "sitrec-upload/abcdefabcdefabcdefab.js",
        "sitrec-upload/foo.abcdefabcdefabcdefab.bundle.js",
    ])("%s is not cached for a year", name => {
        expect(immutable.test(root(name))).toBe(false);
    });

    // Every fixed-name file on the startup path. "" is the directory request.
    test.each([
        "",
        "index.html",
        "index.css",
        "app-entry.json",
        "build-info.json",
        "sitrec-runtime-env.js",
        "sitrec-channel-config.js",
    ])("startup file '%s' is checked on every load", name => {
        expect(noCache.test(root(name))).toBe(true);
    });
});

describe("the shipped Node servers set the same baseline", () => {
    const servers = ["standalone-server.js", "standalone-serverless.js"];

    test.each(servers.flatMap(s => Object.entries(BASELINE).map(([h, v]) => [s, h, v])))(
        "%s sets %s", (server, header, value) => {
            const src = read(server);
            expect(src).toMatch(new RegExp(`setHeader\\(\\s*['"]${header}['"]\\s*,\\s*['"]${value}['"]`));
        });
});

describe("the headers that are deliberately not shipped", () => {
    // Guards the decision, not the code. If one of these is ever added, this test
    // fails and forces the reasoning in SecurityHeaders.md to be revisited rather
    // than the doc silently going stale. Permissions-Policy is the sharp one:
    // Sitrec uses geolocation and device orientation, so a restrictive policy
    // disables "use my location" and AR mode.
    const conf = read("docker", "security-headers.conf");
    const directives = conf.split("\n").filter(l => /^\s*Header\s/.test(l)).join("\n");

    test.each([
        "Content-Security-Policy",
        "Strict-Transport-Security",
        "X-Frame-Options",
        "Permissions-Policy",
    ])("%s is left to the deployment", (header) => {
        expect(directives).not.toContain(header);
    });

    test("the reasoning is written down", () => {
        expect(fs.existsSync(path.join(ROOT, "docs", "dev", "SecurityHeaders.md"))).toBe(true);
    });
});
