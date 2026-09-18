/**
 * Tests for the shared.env.example version stamp mechanism
 * (scripts/sharedEnvVersion.js): version parsing/ordering, commit-time bump
 * logic, and the build-time freshness gate wired into webpack.common.js.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const SCRIPT = path.resolve(__dirname, "..", "scripts", "sharedEnvVersion.js");
const {
    readVersion,
    parseVersion,
    compareVersions,
    nextVersion,
    setVersion,
    stripVersionLines,
    settingLines,
    check,
} = require(SCRIPT);

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

describe("settingLines (comments are stripped by scripts/envFile.js)", () => {
    test("settingLines ignores comments, blank lines and the version line", () => {
        const a = "# header\nSHARED_ENV_VERSION=2026-01-01\n\nFOO=1\nBAR=\"#FFF\"\n";
        const b =
            "# a new header\n# with a second line\nSHARED_ENV_VERSION=2026-08-06\n" +
            "FOO=1   # now documented\n   \n\n# NEW_OPTIONAL=true\nBAR=\"#FFF\"\r\n";
        expect(settingLines(a)).toBe("FOO=1\nBAR=\"#FFF\"");
        expect(settingLines(b)).toBe(settingLines(a));
    });

    test("settingLines sees a changed, added, removed or moved setting", () => {
        const base = settingLines("FOO=1\nBAR=\"#FFF\"\n");
        expect(settingLines("FOO=2\nBAR=\"#FFF\"\n")).not.toBe(base);
        expect(settingLines("FOO=1\nBAR=\"#000\"\n")).not.toBe(base);
        expect(settingLines("FOO=1\nBAR=\"#FFF\"\nNEW=1\n")).not.toBe(base);
        expect(settingLines("FOO=1\n")).not.toBe(base);
        expect(settingLines("BAR=\"#FFF\"\nFOO=1\n")).not.toBe(base);
        // Uncommenting an optional setting activates it.
        expect(settingLines("FOO=1\nBAR=\"#FFF\"\n#NEW=1\n")).toBe(base);
        expect(settingLines("FOO=1\nBAR=\"#FFF\"\nNEW=1\n")).not.toBe(base);
    });
});

describe("commit-time stamping (--bump-staged)", () => {
    const EXAMPLE = path.join("config", "shared.env.example");
    const BASE = "# header\nSHARED_ENV_VERSION=2026-01-01\n\nFOO=1\nBANNER_COLOR=\"#FFFFFF\"\n";
    let dir;

    function git(...args) {
        return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    }

    // Stage new example content and run the hook's command against the scratch repo.
    function stageAndBump(content) {
        fs.writeFileSync(path.join(dir, EXAMPLE), content);
        git("add", EXAMPLE);
        const r = spawnSync(process.execPath, [SCRIPT, "--bump-staged"], {
            env: { ...process.env, SHARED_ENV_ROOT: dir },
            encoding: "utf8",
        });
        return { status: r.status, version: readVersion(fs.readFileSync(path.join(dir, EXAMPLE), "utf8")) };
    }

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-env-bump-"));
        fs.mkdirSync(path.join(dir, "config"));
        fs.writeFileSync(path.join(dir, EXAMPLE), BASE);
        git("init", "-q");
        git("add", EXAMPLE);
        // A throwaway fixture repository: no hooks, no signing, no identity needed.
        git("-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false",
            "commit", "-q", "--no-verify", "-m", "fixture");
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test("comment and blank-line edits do not bump", () => {
        const r = stageAndBump(
            "# header, reworded\n# and extended\nSHARED_ENV_VERSION=2026-01-01\n\n\n" +
            "FOO=1   # now with a note\n# NEW_OPTIONAL=true\nBANNER_COLOR=\"#FFFFFF\" # white\n"
        );
        expect(r.status).toBe(3);
        expect(r.version).toBe("2026-01-01");
    });

    test("a changed setting bumps", () => {
        const r = stageAndBump(BASE.replace("FOO=1", "FOO=2"));
        expect(r.status).toBe(0);
        expect(compareVersions(r.version, "2026-01-01")).toBe(1);
    });

    test("a change after a '#' inside quotes bumps", () => {
        const r = stageAndBump(BASE.replace("#FFFFFF", "#000000"));
        expect(r.status).toBe(0);
        expect(compareVersions(r.version, "2026-01-01")).toBe(1);
    });

    test("a manual bump with only comment edits is kept", () => {
        const r = stageAndBump(BASE.replace("# header", "# new header").replace("2026-01-01", "2026-02-01"));
        expect(r.status).toBe(3);
        expect(r.version).toBe("2026-02-01");
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
