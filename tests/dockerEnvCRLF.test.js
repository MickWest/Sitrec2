/**
 * Regression tests for the Windows (CRLF) env-file bug in the Docker config path.
 *
 * These exercise the REAL shell parsers end-to-end (not replicas), so they catch
 * an upstream parser that emits e.g. OpenStreetMap"\r even if the JS-side getEnv
 * tests still pass:
 *   - install.sh --bake   (the user's reported path)   via SITREC_BAKE_DRY_RUN
 *   - sitrec.sh bake                                    via SITREC_BAKE_DRY_RUN
 *   - docker/entrypoint.sh (docker-compose env_file:)   via SITREC_ENTRYPOINT_NO_EXEC
 *
 * They also cover the sed-injection hazard: a custom map URL containing '&'
 * (...?token=a&style=b) must survive injection into window.__SITREC_ENV__ without
 * the matched <head> being spliced into it.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");

// These tests shell out to bash; skip on Windows where the scripts can't run.
const describeUnix = process.platform === "win32" ? describe.skip : describe;

// A CRLF env file with the four cases from the bug report:
//  - a double-quoted name        -> must lose BOTH quotes, no trailing "
//  - a URL containing '&'        -> must stay intact (no quote, no <head> splice)
//  - a double-quoted bool flag   -> must become exactly "false"
//  - an unquoted type            -> must stay an exact key, no trailing CR
const CRLF_ENV =
    'SITREC_CUSTOM_MAP_OSM_NAME="OpenStreetMap"\r\n' +
    "SITREC_CUSTOM_MAP_OSM_URL=https://tiles/{z}/{x}/{y}.png?token=a&style=b\r\n" +
    'SITREC_ENABLE_DEFAULT_MAP_SOURCES="false"\r\n' +
    "DOCKER_MAP_TYPE=CustomMap_OSM\r\n";

function mkFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sitrec-crlf-"));
    const envFile = path.join(dir, "shared.env");
    fs.writeFileSync(envFile, CRLF_ENV);
    return { dir, envFile };
}

// Assert a generated Dockerfile bakes clean ENV values (no literal quotes, no CR).
function expectCleanBakedDockerfile(stdout) {
    const envLines = stdout.split("\n").filter((l) => l.startsWith("ENV "));
    const joined = envLines.join("\n");

    // No carriage returns and no escaped literal quotes leaked into any value.
    expect(joined).not.toMatch(/\r/);
    expect(joined).not.toContain('\\"');

    expect(envLines).toContain('ENV SITREC_CUSTOM_MAP_OSM_NAME="OpenStreetMap"');
    expect(envLines).toContain('ENV SITREC_CUSTOM_MAP_OSM_URL="https://tiles/{z}/{x}/{y}.png?token=a&style=b"');
    expect(envLines).toContain('ENV SITREC_ENABLE_DEFAULT_MAP_SOURCES="false"');
    expect(envLines).toContain('ENV DOCKER_MAP_TYPE="CustomMap_OSM"');
}

describeUnix("Docker bake parsers strip CRLF (install.sh / sitrec.sh)", () => {
    test("install.sh --bake bakes clean ENV values from a CRLF env file", () => {
        const { envFile } = mkFixture();
        const stdout = execFileSync(
            "bash",
            [path.join(REPO, "install.sh"), "--bake", "dummy:tag", "--env-file", envFile],
            { cwd: REPO, encoding: "utf8", env: { ...process.env, SITREC_BAKE_DRY_RUN: "1" } }
        );
        expectCleanBakedDockerfile(stdout);
    });

    test("sitrec.sh bake bakes clean ENV values from a CRLF env file", () => {
        const { envFile } = mkFixture();
        const stdout = execFileSync(
            "bash",
            [path.join(REPO, "sitrec.sh"), "bake", "--env-file", envFile, "dummy:tag"],
            { cwd: REPO, encoding: "utf8", env: { ...process.env, SITREC_BAKE_DRY_RUN: "1" } }
        );
        expectCleanBakedDockerfile(stdout);
    });
});

// The entrypoint writes to /etc/apache2 only when root; skip as root so the
// apache-config writes (absent outside the container) don't abort under set -e.
const canRunEntrypoint = process.platform !== "win32" && !(process.getuid && process.getuid() === 0);
const describeEntrypoint = canRunEntrypoint ? describe : describe.skip;

describeEntrypoint("docker/entrypoint.sh strips CRLF + quotes (compose env_file: path)", () => {
    test("clean shared.env.php and a JSON-valid, &-safe window.__SITREC_ENV__", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sitrec-entry-"));
        const htmlFile = path.join(dir, "index.html");
        const envPhpFile = path.join(dir, "shared.env.php");
        fs.writeFileSync(htmlFile, "<!doctype html><html><head></head><body>x</body></html>\n");

        // Simulate the docker-compose env_file: path: values arrive with a trailing
        // CR (CRLF file) and, for some compose tools, surrounding quotes.
        execFileSync("bash", [path.join(REPO, "docker", "entrypoint.sh")], {
            cwd: REPO,
            encoding: "utf8",
            env: {
                ...process.env,
                SITREC_ENTRYPOINT_NO_EXEC: "1",
                SITREC_HTML_FILE: htmlFile,
                SITREC_ENV_PHP_FILE: envPhpFile,
                SITREC_CUSTOM_MAP_OSM_NAME: '"OpenStreetMap"\r',
                SITREC_CUSTOM_MAP_OSM_URL: "https://tiles/{z}/{x}/{y}.png?token=a&style=b\r",
                SITREC_ENABLE_DEFAULT_MAP_SOURCES: '"false"\r',
                DOCKER_MAP_TYPE: "CustomMap_OSM\r",
            },
        });

        // shared.env.php: values clean (no CR, no stray quote)
        const php = fs.readFileSync(envPhpFile, "utf8");
        expect(php).not.toMatch(/\r/);
        expect(php).toContain("SITREC_ENABLE_DEFAULT_MAP_SOURCES=false\n");
        expect(php).toContain("SITREC_CUSTOM_MAP_OSM_NAME=OpenStreetMap\n");

        // window.__SITREC_ENV__: must be valid JSON (raw CR or bad escaping would break it)
        const html = fs.readFileSync(htmlFile, "utf8");
        const m = html.match(/window\.__SITREC_ENV__=(\{.*?\});<\/script>/s);
        expect(m).not.toBeNull();
        const env = JSON.parse(m[1]);

        expect(env.SITREC_CUSTOM_MAP_OSM_NAME).toBe("OpenStreetMap");
        expect(env.SITREC_ENABLE_DEFAULT_MAP_SOURCES).toBe("false");
        expect(env.DOCKER_MAP_TYPE).toBe("CustomMap_OSM");
        // The '&' URL survives intact, with no matched <head> spliced into it.
        expect(env.SITREC_CUSTOM_MAP_OSM_URL).toBe("https://tiles/{z}/{x}/{y}.png?token=a&style=b");
        expect(env.SITREC_CUSTOM_MAP_OSM_URL).not.toContain("<head>");
    });
});
