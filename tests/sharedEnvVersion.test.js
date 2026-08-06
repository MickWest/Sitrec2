/**
 * Tests for the shared.env.example version stamp mechanism
 * (scripts/sharedEnvVersion.js): version parsing/ordering, commit-time bump
 * logic, and the build-time freshness gate wired into webpack.common.js.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    readVersion,
    parseVersion,
    compareVersions,
    nextVersion,
    setVersion,
    stripVersionLines,
    check,
} = require(path.resolve(__dirname, "..", "scripts", "sharedEnvVersion.js"));

describe("version parsing and ordering", () => {
    test("parses bare dates and same-day sequence suffixes", () => {
        expect(parseVersion("2026-08-06")).toEqual({ date: "2026-08-06", seq: 0 });
        expect(parseVersion("2026-08-06.3")).toEqual({ date: "2026-08-06", seq: 3 });
        expect(parseVersion("garbage")).toBeNull();
        expect(parseVersion(null)).toBeNull();
    });

    test("orders by date then sequence, numerically not lexically", () => {
        expect(compareVersions("2026-08-05", "2026-08-06")).toBe(-1);
        expect(compareVersions("2026-08-06", "2026-08-06")).toBe(0);
        expect(compareVersions("2026-08-06.1", "2026-08-06")).toBe(1);
        // .10 must beat .2 — the reason we parse instead of comparing strings
        expect(compareVersions("2026-08-06.10", "2026-08-06.2")).toBe(1);
    });

    test("malformed versions sort oldest (fail closed)", () => {
        expect(compareVersions("not-a-date", "2026-08-06")).toBe(-1);
        expect(compareVersions("2026-08-06", "not-a-date")).toBe(1);
    });

    test("nextVersion moves to today, adding .N for same-day bumps", () => {
        expect(nextVersion("2026-08-01", "2026-08-06")).toBe("2026-08-06");
        expect(nextVersion("2026-08-06", "2026-08-06")).toBe("2026-08-06.1");
        expect(nextVersion("2026-08-06.2", "2026-08-06")).toBe("2026-08-06.3");
        expect(nextVersion(null, "2026-08-06")).toBe("2026-08-06");
    });

    test("nextVersion never goes backwards when 'today' trails the stamp", () => {
        // Contributors in different time zones straddling midnight: a bare
        // "today" would be older than the existing stamp, so installs holding
        // the newer stamp would never be told about this change.
        const v = nextVersion("2026-08-07", "2026-08-06");
        expect(compareVersions(v, "2026-08-07")).toBe(1);
        expect(v).toBe("2026-08-07.1");
    });
});

describe("version line read/write", () => {
    test("readVersion finds the stamp among other settings", () => {
        expect(readVersion("# header\nSHARED_ENV_VERSION=2026-08-06\nFOO=1\n")).toBe("2026-08-06");
        expect(readVersion("FOO=1\n")).toBeNull();
    });

    test("setVersion replaces in place, preserving the rest", () => {
        const before = "# header\nSHARED_ENV_VERSION=2026-01-01\nFOO=1\n";
        const after = setVersion(before, "2026-08-06");
        expect(readVersion(after)).toBe("2026-08-06");
        expect(after).toContain("# header");
        expect(after).toContain("FOO=1");
    });

    test("setVersion prepends when no stamp exists", () => {
        const after = setVersion("FOO=1\n", "2026-08-06");
        expect(readVersion(after)).toBe("2026-08-06");
        expect(after).toContain("FOO=1");
    });

    test("stripVersionLines makes bump detection ignore the stamp itself", () => {
        const a = "# h\nSHARED_ENV_VERSION=2026-01-01\nFOO=1\n";
        const b = "# h\nSHARED_ENV_VERSION=2026-08-06\nFOO=1\n";
        expect(stripVersionLines(a)).toBe(stripVersionLines(b));
    });
});

describe("build-time freshness gate", () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-env-test-"));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function run(envContent, exampleContent) {
        const envPath = path.join(dir, "shared.env");
        const examplePath = path.join(dir, "shared.env.example");
        if (envContent !== null) fs.writeFileSync(envPath, envContent);
        if (exampleContent !== null) fs.writeFileSync(examplePath, exampleContent);
        // cwd = temp dir (not a git repo) exercises the GitHub-links fallback
        return check({ envPath, examplePath, cwd: dir });
    }

    test("matching versions pass", () => {
        expect(run("SHARED_ENV_VERSION=2026-08-06\n", "SHARED_ENV_VERSION=2026-08-06\n").ok).toBe(true);
    });

    test("newer local version passes (older branch must still build)", () => {
        expect(run("SHARED_ENV_VERSION=2026-09-01\n", "SHARED_ENV_VERSION=2026-08-06\n").ok).toBe(true);
    });

    test("older local version blocks with instructions", () => {
        const r = run("SHARED_ENV_VERSION=2026-05-01\nFOO=1\n", "SHARED_ENV_VERSION=2026-08-06\n");
        expect(r.ok).toBe(false);
        expect(r.message).toContain("out of date");
        expect(r.message).toContain("SHARED_ENV_VERSION=2026-08-06");
        // No git in the temp dir → must point at GitHub history instead
        expect(r.message).toContain("github.com/MickWest/Sitrec2");
    });

    test("missing local stamp blocks (pre-versioning shared.env)", () => {
        const r = run("FOO=1\n", "SHARED_ENV_VERSION=2026-08-06\n");
        expect(r.ok).toBe(false);
        expect(r.message).toContain("predates version stamping");
    });

    test("unstamped example passes (old branch checkout)", () => {
        expect(run("FOO=1\n", "# no stamp\nFOO=1\n").ok).toBe(true);
    });

    test("malformed example stamp fails instead of disabling the gate", () => {
        // A stamp that is present but unparseable (bad merge, hand edit) must
        // not silently turn freshness checking off for every build.
        const r = run("SHARED_ENV_VERSION=2026-08-06\n", "SHARED_ENV_VERSION=oops\n");
        expect(r.ok).toBe(false);
        expect(r.message).toContain("malformed");
    });

    test("a version containing shell metacharacters cannot execute commands", () => {
        // readVersion accepts any non-whitespace value, and the failure path
        // feeds it to git as a search term — so git must never be invoked
        // through a shell. cwd is the real repo, so the git call actually runs.
        const marker = path.join(dir, "INJECTED");
        const envPath = path.join(dir, "shared.env");
        const examplePath = path.join(dir, "shared.env.example");
        fs.writeFileSync(envPath, `SHARED_ENV_VERSION=$(touch\${IFS}${marker})\n`);
        fs.writeFileSync(examplePath, "SHARED_ENV_VERSION=2026-08-06\n");

        const r = check({ envPath, examplePath, cwd: path.resolve(__dirname, "..") });

        expect(r.ok).toBe(false);
        expect(fs.existsSync(marker)).toBe(false);
    });

    test("missing shared.env passes (handled elsewhere)", () => {
        expect(run(null, "SHARED_ENV_VERSION=2026-08-06\n").ok).toBe(true);
    });

    test("missing example passes (handled elsewhere)", () => {
        expect(run("FOO=1\n", null).ok).toBe(true);
    });

    test("the real example file carries a parseable stamp", () => {
        const example = fs.readFileSync(
            path.resolve(__dirname, "..", "config", "shared.env.example"),
            "utf8"
        );
        expect(parseVersion(readVersion(example))).not.toBeNull();
    });
});
