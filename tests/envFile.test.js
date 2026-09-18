/**
 * shared.env comments are read the same way by every loader: the build
 * (scripts/envFile.js, including the dotenv-webpack plugin), PHP
 * (sitrecServer/injectEnv.php), the Docker bake parsers (install.sh,
 * sitrec.sh) and the Docker entrypoint's shared.env.php writer.
 *
 * One fixture of awkward lines goes through each of them and must give the
 * same values. The PHP and shell cases run the real files, and skip where
 * php or bash is not available.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const {
    stripComment,
    stripComments,
    parseEnv,
    loadEnvIntoProcess,
    commentAwareDotenvPlugin,
} = require(path.join(REPO, "scripts", "envFile.js"));

// Tab and CR are written as escapes so the fixture's whitespace is exact.
const FIXTURE =
    "# a full-line comment\n" +
    "   # an indented comment\n" +
    "\n" +
    "PLAIN=abc\n" +
    "TRAILING=abc # note\n" +
    "TRAILING_TAB=abc\t# tab note\n" +
    'QUOTED_HASH="#FFFFFF"\n' +
    'QUOTED_HASH_COMMENT="#FFFFFF"   # white\n' +
    "SINGLE_HASH='#377e22' # green\n" +
    'INNER_HASH="Meet at 5 # room 2"  # a real comment\n' +
    "NO_SPACE_HASH=https://host/page#top\n" +
    "NO_SPACE_HASH_COMMENT=https://host/page#top # comment\n" +
    'ESCAPED_QUOTE="say \\"hi # there\\"" # c\n' +
    "APOSTROPHE=It's ready # note\n" +
    'UNCLOSED="open # kept, because the quote never closes\n' +
    "CRLF_COMMENT=abc # note\r\n";

// None is true/false/numeric, so PHP's type conversion does not apply.
const EXPECTED = {
    PLAIN: "abc",
    TRAILING: "abc",
    TRAILING_TAB: "abc",
    QUOTED_HASH: "#FFFFFF",
    QUOTED_HASH_COMMENT: "#FFFFFF",
    SINGLE_HASH: "#377e22",
    INNER_HASH: "Meet at 5 # room 2",
    NO_SPACE_HASH: "https://host/page#top",
    NO_SPACE_HASH_COMMENT: "https://host/page#top",
    // dotenv 8 and PHP both keep the backslashes; what matters is no cut at the '#'.
    ESCAPED_QUOTE: 'say \\"hi # there\\"',
    APOSTROPHE: "It's ready",
    UNCLOSED: '"open # kept, because the quote never closes',
    CRLF_COMMENT: "abc",
};

function tempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const hasPhp = spawnSync("php", ["-v"], { encoding: "utf8" }).status === 0;
const describePhp = hasPhp ? describe : describe.skip;
const describeUnix = process.platform === "win32" ? describe.skip : describe;

// Run the real injectEnv.php on shared.env.php content and return getenv() for keys.
// injectEnv.php opens '../shared.env.php' relative to the working directory.
function readWithPhp(envPhpContent, keys) {
    const dir = tempDir("sitrec-injectenv-");
    const cwd = path.join(dir, "sitrecServer");
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(dir, "shared.env.php"), envPhpContent);
    const code =
        "require $argv[1]; $out = [];" +
        "foreach (array_slice($argv, 2) as $k) { $out[$k] = getenv($k); }" +
        "echo json_encode($out);";
    const r = spawnSync("php", ["-r", code, path.join(REPO, "sitrecServer", "injectEnv.php"), ...keys], {
        cwd,
        encoding: "utf8",
    });
    fs.rmSync(dir, { recursive: true, force: true });
    if (r.status !== 0) throw new Error(`php failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
    return JSON.parse(r.stdout);
}

// The ENV lines of a bake dry run, with the Dockerfile escapes undone.
function bakedValues(stdout) {
    const values = {};
    for (const line of stdout.split("\n")) {
        const m = line.match(/^ENV ([A-Za-z0-9_]+)="(.*)"$/);
        if (m) values[m[1]] = m[2].replace(/\\(["\\$])/g, "$1");
    }
    return values;
}

describe("stripComment", () => {
    test("removes full-line and trailing comments", () => {
        expect(stripComment("# a comment")).toBe("");
        expect(stripComment("   # indented comment")).toBe("");
        expect(stripComment("FOO=1 # note")).toBe("FOO=1");
        expect(stripComment("FOO=1\t# note")).toBe("FOO=1");
        expect(stripComment("  FOO=1   ")).toBe("FOO=1");
    });

    test("keeps a '#' inside quotes", () => {
        expect(stripComment('BANNER_COLOR="#FFFFFF"')).toBe('BANNER_COLOR="#FFFFFF"');
        expect(stripComment("BANNER_COLOR='#FFFFFF'")).toBe("BANNER_COLOR='#FFFFFF'");
        expect(stripComment('BANNER_COLOR="#FFFFFF" # white')).toBe('BANNER_COLOR="#FFFFFF"');
        expect(stripComment('A="x # not a comment" # comment')).toBe('A="x # not a comment"');
        // An escaped quote does not close the string.
        expect(stripComment('A="say \\"hi # there\\"" # c')).toBe('A="say \\"hi # there\\""');
        // A single-quoted string has no escapes, so a backslash is literal.
        expect(stripComment("A='x\\' # c")).toBe("A='x\\'");
    });

    test("keeps a '#' that does not follow whitespace", () => {
        expect(stripComment("URL=https://host/page#part")).toBe("URL=https://host/page#part");
        expect(stripComment("COLOR=#FFFFFF")).toBe("COLOR=#FFFFFF");
    });

    test("keeps the whole line when the value's opening quote is not closed", () => {
        expect(stripComment('A="open # maybe a comment')).toBe('A="open # maybe a comment');
        expect(stripComment("A='open # maybe a comment")).toBe("A='open # maybe a comment");
    });

    test("a quote opens only at the start of the value, as in docker compose", () => {
        expect(stripComment("A=It's ready # note")).toBe("A=It's ready");
        expect(stripComment('A=say "hi # there"')).toBe('A=say "hi');
        expect(stripComment('A=   "x # y" # z')).toBe('A=   "x # y"');
        expect(stripComment("# it's a comment")).toBe("");
        expect(stripComment("<?php /*; it's # not a setting")).toBe("<?php /*; it's");
    });

    test("stripComments keeps one output line per input line", () => {
        expect(stripComments("A=1 # x\r\n# y\nB=2")).toBe("A=1\n\nB=2");
    });
});

describe("build loaders (scripts/envFile.js)", () => {
    test("parseEnv reads the fixture", () => {
        expect(parseEnv(FIXTURE)).toEqual(EXPECTED);
    });

    test("parseEnv matches dotenv 8 on lines without comments", () => {
        const dotenv = require("dotenv");
        const plain = 'A=1\nB="two words"\nC=\'x\'\nD="line\\nbreak"\nE=\n  F = spaced  \n';
        expect(parseEnv(plain)).toEqual(dotenv.parse(plain));
    });

    test("loadEnvIntoProcess keeps values already in process.env", () => {
        const dir = tempDir("sitrec-envfile-");
        const file = path.join(dir, "shared.env");
        fs.writeFileSync(file, "SITREC_TEST_ENVFILE_A=from-file # c\nSITREC_TEST_ENVFILE_B=from-file\n");
        process.env.SITREC_TEST_ENVFILE_B = "preset";
        try {
            loadEnvIntoProcess(file);
            expect(process.env.SITREC_TEST_ENVFILE_A).toBe("from-file");
            expect(process.env.SITREC_TEST_ENVFILE_B).toBe("preset");
        } finally {
            delete process.env.SITREC_TEST_ENVFILE_A;
            delete process.env.SITREC_TEST_ENVFILE_B;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("loadEnvIntoProcess throws when the file is missing", () => {
        expect(() => loadEnvIntoProcess(path.join(os.tmpdir(), "no-such-dir-xyz", "shared.env"))).toThrow();
    });

    test("the dotenv-webpack plugin reads the fixture the same way", () => {
        const dir = tempDir("sitrec-envfile-");
        const file = path.join(dir, "shared.env");
        fs.writeFileSync(file, FIXTURE);
        try {
            const plugin = commentAwareDotenvPlugin({ path: file });
            expect(plugin.getEnvs().env).toEqual(EXPECTED);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("the plugin is still named Dotenv, so serverless and secure builds drop it", () => {
        // webpack.serverless.js and webpack.secure.js remove it by constructor.name.
        // If they did not, every shared.env value would reach a public bundle.
        const plugin = commentAwareDotenvPlugin({ path: path.join(os.tmpdir(), "unused.env") });
        expect(plugin.constructor.name).toBe("Dotenv");
        for (const config of ["webpack.serverless.js", "webpack.secure.js"]) {
            const source = fs.readFileSync(path.join(REPO, config), "utf8");
            expect(source).toContain("plugin.constructor.name !== 'Dotenv'");
        }
    });
});

describePhp("PHP loader (sitrecServer/injectEnv.php)", () => {
    test("reads the fixture the same way", () => {
        const content = `<?php /*;\n${FIXTURE}\n*/`;
        expect(readWithPhp(content, Object.keys(EXPECTED))).toEqual(EXPECTED);
    });
});

describeUnix("Docker bake parsers (install.sh, sitrec.sh)", () => {
    let dir, envFile;
    beforeAll(() => {
        dir = tempDir("sitrec-bake-");
        envFile = path.join(dir, "prod.env");
        fs.writeFileSync(envFile, FIXTURE);
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    const DRY_RUN = { ...process.env, SITREC_BAKE_DRY_RUN: "1" };

    test("install.sh --bake reads the fixture the same way", () => {
        const stdout = execFileSync(
            "bash",
            [path.join(REPO, "install.sh"), "--bake", "dummy:tag", "--env-file", envFile],
            { cwd: REPO, encoding: "utf8", env: DRY_RUN }
        );
        expect(bakedValues(stdout)).toEqual(EXPECTED);
    });

    test("sitrec.sh bake reads the fixture the same way", () => {
        const stdout = execFileSync(
            "bash",
            [path.join(REPO, "sitrec.sh"), "bake", "--env-file", envFile, "dummy:tag"],
            { cwd: REPO, encoding: "utf8", env: DRY_RUN }
        );
        expect(bakedValues(stdout)).toEqual(EXPECTED);
    });
});

// The entrypoint writes to /etc/apache2 only when root; skip as root (see dockerEnvCRLF.test.js).
const canRunEntrypoint = process.platform !== "win32" && !(process.getuid && process.getuid() === 0);
(canRunEntrypoint && hasPhp ? describe : describe.skip)("Docker entrypoint -> PHP", () => {
    test("a value that contains ' #' reaches PHP whole", () => {
        const dir = tempDir("sitrec-entry-hash-");
        const htmlFile = path.join(dir, "index.html");
        const envPhpFile = path.join(dir, "shared.env.php");
        fs.writeFileSync(htmlFile, "<!doctype html><html><head></head><body>x</body></html>\n");
        const values = {
            BANNER_TOP_TEXT: "Meet at 5 # room 2",       // no quotes of its own: written in '...'
            BANNER_BOTTOM_TEXT: "it's 5 # still text",  // has a ': written in "..."
            BANNER_COLOR: "#FFFFFF",                    // no space before '#': written as it is
            BANNER_FONT: "it's C:\\fonts # x",          // ' and a backslash: written in "..."
            LOCALHOST: "it's # ends in \\",             // backslash just before the closing "
        };
        try {
            execFileSync("bash", [path.join(REPO, "docker", "entrypoint.sh")], {
                cwd: REPO,
                encoding: "utf8",
                env: {
                    ...process.env,
                    SITREC_ENTRYPOINT_NO_EXEC: "1",
                    SITREC_HTML_FILE: htmlFile,
                    SITREC_ENV_PHP_FILE: envPhpFile,
                    ...values,
                },
            });
            const php = fs.readFileSync(envPhpFile, "utf8");
            expect(php).toContain("BANNER_TOP_TEXT='Meet at 5 # room 2'\n");
            expect(php).toContain('BANNER_BOTTOM_TEXT="it\'s 5 # still text"\n');
            expect(php).toContain("BANNER_COLOR=#FFFFFF\n");
            expect(php).toContain('BANNER_FONT="it\'s C:\\fonts # x"\n');
            expect(readWithPhp(php, Object.keys(values))).toEqual(values);

            // The browser copy is JSON, so it needs no quoting and must not get any.
            const js = fs.readFileSync(path.join(dir, "sitrec-runtime-env.js"), "utf8");
            const env = JSON.parse(js.match(/^window\.__SITREC_ENV__=(\{.*?\});\n$/s)[1]);
            expect(env.BANNER_TOP_TEXT).toBe(values.BANNER_TOP_TEXT);
            expect(env.BANNER_BOTTOM_TEXT).toBe(values.BANNER_BOTTOM_TEXT);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
