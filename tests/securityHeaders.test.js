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
