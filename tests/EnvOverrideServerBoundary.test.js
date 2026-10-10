/**
 * The user's "SITREC_ ENV Override" setting must not reach the server's configuration.
 *
 * The override is text a user types (src/EnvOverride.js). The browser applies it to what
 * the BROWSER reads. The server stores the text with the user's other settings and
 * returns it, and that is all the server does with it. These tests hold the reasons that
 * is true, so a later change that breaks one of them fails here:
 *
 *   1. PHP gets its environment in one place, from one fixed file.
 *   2. Nothing in PHP writes that file.
 *   3. No PHP reads the override except the settings sanitizer, which checks it and
 *      copies it as text.
 *   4. Only settings.php reads the stored settings, and the user chooses no part of
 *      the path they are stored at.
 *   5. No PHP endpoint takes a SITREC_ setting from the request.
 *   6. The browser sends the override text to the server only inside a settings save.
 *
 * The last block runs the real PHP: it stores hostile override text the way settings.php
 * does, then starts a new PHP process as the next request would, and checks that the
 * environment it loads is the installation's. It is skipped when php is not available.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const SERVER_DIR = path.join(REPO, "sitrecServer");
const SRC_DIR = path.join(REPO, "src");

function filesUnder(dir, extension, skip = []) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...filesUnder(full, extension, skip));
        else if (entry.name.endsWith(extension)) found.push(full);
    }
    return found;
}

// PHP source with comments removed, so a rule is not tripped by prose about it.
function phpCode(file) {
    return fs.readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n").map(line => line.replace(/^\s*(\/\/|#).*$/, "")).join("\n");
}

// The body of a PHP function, from its opening brace to the matching closing brace, or
// null if the code has no function of that name.
function functionBody(code, name) {
    const start = code.search(new RegExp(String.raw`\bfunction\s+${name}\s*\(`));
    if (start < 0) return null;
    const open = code.indexOf("{", start);
    let depth = 0;
    for (let index = open; index < code.length; index++) {
        if (code[index] === "{") depth++;
        else if (code[index] === "}" && --depth === 0) return code.slice(open, index + 1);
    }
    return null;
}

const phpFiles = filesUnder(SERVER_DIR, ".php", ["vendor"]);
const relative = file => path.relative(REPO, file);

describe("the server's configuration has one source, and the override is not it", () => {
    test("1. PHP sets environment variables in one place only: injectEnv.php", () => {
        const setters = [];
        for (const file of phpFiles) {
            const code = phpCode(file);
            if (/\bputenv\s*\(|\bapache_setenv\s*\(|\$_ENV\s*\[[^\]]+\]\s*=[^=]/.test(code)) setters.push(relative(file));
        }
        expect(setters).toEqual(["sitrecServer/injectEnv.php"]);
    });

    test("1. injectEnv.php reads one fixed file, not anything from the request or the user", () => {
        const code = phpCode(path.join(SERVER_DIR, "injectEnv.php"));
        expect(code).toContain("$filename = '../shared.env.php';");
        expect(code).not.toMatch(/\$_(GET|POST|REQUEST|COOKIE|FILES|SESSION)\b/);
        expect(code).not.toMatch(/php:\/\/input|settings|user_id|UPLOAD_PATH/);
        // The only file it opens is that one.
        expect(code.match(/\bfile(_get_contents)?\s*\(\s*\$filename\b/g)).toHaveLength(1);
        expect(code).not.toMatch(/\b(include|require)(_once)?\b/);
    });

    test("2. no PHP file writes shared.env.php or any other configuration file", () => {
        // A call that writes or moves a file, with a configuration file named in the call.
        const writeCall = /\b(file_put_contents|fopen|fwrite|rename|copy|move_uploaded_file|touch|unlink)\s*\(/;
        const configName = /shared\.env|config(_paths)?\.php|injectEnv|\.htaccess|\.user\.ini|php\.ini/;
        const writers = [];
        for (const file of phpFiles) {
            for (const line of phpCode(file).split("\n")) {
                if (writeCall.test(line) && configName.test(line)) writers.push(`${relative(file)}: ${line.trim()}`);
            }
        }
        expect(writers).toEqual([]);

        // And the variable injectEnv.php reads from is used for reading only.
        const injectEnv = phpCode(path.join(SERVER_DIR, "injectEnv.php"));
        expect(injectEnv).not.toMatch(writeCall);
    });

    test("3. no PHP reads the override except to check it and copy it, in the settings sanitizer", () => {
        // $name['envOverride'], with any spacing and either quote.
        const KEY = String.raw`\$(\w+)\s*\[\s*['"]envOverride['"]\s*\]`;
        const copies = new RegExp(String.raw`^\s*=\s*\$settings\s*\[\s*['"]envOverride['"]\s*\]\s*;`);
        const checkedBy = /\b(isset|is_string|strlen)\s*\(\s*$/;
        const copiedInto = new RegExp(String.raw`\$sanitized\s*\[\s*['"]envOverride['"]\s*\]\s*=\s*$`);

        const misuses = [];
        let copyCount = 0;
        for (const file of phpFiles) {
            const code = phpCode(file);
            if (!code.includes("envOverride")) continue;
            const sanitizer = functionBody(code, "sanitizeSettings");
            // Outside a settings sanitizer, PHP does not name it at all.
            const outside = sanitizer === null ? code : code.replace(sanitizer, "");
            if (outside.includes("envOverride")) misuses.push(`${relative(file)}: named outside sanitizeSettings()`);
            if (sanitizer === null) continue;
            // Inside, the input value is only tested (isset, is_string, strlen) or copied as
            // it is into the output; the output value is only assigned.
            const nameCount = (sanitizer.match(/envOverride/g) ?? []).length;
            const uses = [...sanitizer.matchAll(new RegExp(KEY, "g"))];
            if (uses.length !== nameCount) misuses.push(`${relative(file)}: envOverride used other than as an array key`);
            for (const use of uses) {
                const before = sanitizer.slice(0, use.index);
                const after = sanitizer.slice(use.index + use[0].length);
                if (use[1] === "sanitized" && copies.test(after)) copyCount++;
                else if (use[1] === "settings" && (checkedBy.test(before) || copiedInto.test(before))) continue;
                else misuses.push(`${relative(file)}: ${use[0]}${after.split("\n")[0]}`);
            }
        }
        expect(misuses).toEqual([]);
        // The text is still copied, so the setting is stored at all.
        expect(copyCount).toBeGreaterThan(0);
    });

    test("4. only settings.php reads the stored settings, at a path the user does not choose", () => {
        const readers = phpFiles.filter(file => /settings\/'\s*\.\s*\$user_id\s*\.\s*'\.json'/.test(phpCode(file)))
            .map(relative);
        expect(readers).toEqual(["sitrecServer/settings.php"]);

        const code = phpCode(path.join(SERVER_DIR, "settings.php"));
        // The user id is the server's, and no request value goes into a path or a key.
        expect(code).toContain("$user_id = getUserID();");
        expect(code).not.toMatch(/\$_(GET|REQUEST|COOKIE|FILES)\b/);
        expect(code).not.toMatch(/\b(eval|include|require|parse_ini_string|parse_ini_file|unserialize|extract|putenv)\s*\(?\s*\$(settings|sanitized|data|input|storedSettings)/);
        // The stored text is used in exactly two ways: json_decode on the way in, json_encode on the way out.
        expect(code).not.toMatch(/\bparse_str\b|\bextract\s*\(/);
    });

    test("5. no PHP endpoint takes a SITREC_ setting from the request", () => {
        const takers = [];
        for (const file of phpFiles) {
            const code = phpCode(file);
            if (/\$_(GET|POST|REQUEST|COOKIE)\s*\[\s*['"]SITREC_/.test(code)) takers.push(relative(file));
            // A header named after a setting would be the other way in.
            if (/\$_SERVER\s*\[\s*['"]HTTP_SITREC_/.test(code)) takers.push(relative(file));
        }
        expect(takers).toEqual([]);
    });

    test("6. the browser sends the override text only in a settings save", () => {
        const REQUEST = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/;

        // EnvOverride.js applies the text and has no way to send anything.
        const applier = fs.readFileSync(path.join(SRC_DIR, "EnvOverride.js"), "utf8");
        expect(applier).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|\.php\b/);

        // No line that names the setting makes a request. Code may read the text to show
        // it or apply it; it does not hand it to a request of its own.
        const senders = [];
        for (const file of filesUnder(SRC_DIR, ".js")) {
            fs.readFileSync(file, "utf8").split("\n").forEach((line, index) => {
                if (/\benvOverride\b/.test(line) && REQUEST.test(line)) senders.push(`${relative(file)}:${index + 1}`);
            });
        }
        expect(senders).toEqual([]);

        // The one request that carries settings goes to settings.php.
        const manager = fs.readFileSync(path.join(SRC_DIR, "SettingsManager.js"), "utf8");
        const endpoints = [...manager.matchAll(/fetch\(\s*withTestUser\(\s*'([^']+)'/g)].map(match => match[1]);
        expect(new Set(endpoints)).toEqual(new Set(["./sitrecServer/settings.php"]));
    });
});

const hasPhp = spawnSync("php", ["-v"], { encoding: "utf8" }).status === 0;
const describePhp = hasPhp ? describe : describe.skip;

describePhp("the real PHP: stored override text does not change the next request's environment", () => {
    // What the installation set.
    const INSTALLATION = {
        SITREC_ENABLE_DEFAULT_MAP_SOURCES: "false",
        SITREC_DEFAULT_USERID: "0",
        SITREC_TRACK_STATS: "false",
        CUSTOM_WIND_URL: "https://wx.example.org/grid?date={YYYY}{MM}{DD}",
        SAVE_TO_S3: "false",
        S3_BUCKET: "installation-bucket",
        OPENAI_API: "installation-key",
    };
    // What a user types to try to change it, with the tricks a parser could fall for.
    const HOSTILE = [
        "SITREC_ENABLE_DEFAULT_MAP_SOURCES=true",
        "SITREC_DEFAULT_USERID=1",
        "SITREC_DEFAULT_USER_GROUPS=3,2,14,9",
        "SITREC_TRACK_STATS=true",
        "CUSTOM_WIND_URL=https://attacker.example.net/{YYYY}",
        "SAVE_TO_S3=true",
        "S3_BUCKET=attacker-bucket",
        "OPENAI_API=attacker-key",
        "NEW_SERVER_SETTING=added",
        "*/ ?>",
        "<?php putenv('PWNED=1'); ?>",
        "\"; putenv('PWNED=2'); //",
    ].join("\n");

    const KEYS = [...Object.keys(INSTALLATION), "SITREC_DEFAULT_USER_GROUPS", "NEW_SERVER_SETTING", "PWNED"];

    function makeInstallation() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "sitrec-override-"));
        const lines = Object.entries(INSTALLATION).map(([key, value]) => `${key}=${value}`).join("\n");
        fs.writeFileSync(path.join(root, "shared.env.php"), `<?php /*;\n${lines}\n*/`);
        fs.mkdirSync(path.join(root, "sitrecServer"));
        fs.mkdirSync(path.join(root, "upload", "settings"), { recursive: true });
        return root;
    }

    // Run PHP code from inside root/sitrecServer, the directory injectEnv.php expects.
    function php(root, code, args = []) {
        const result = spawnSync("php", ["-r", code, ...args], { cwd: path.join(root, "sitrecServer"), encoding: "utf8" });
        if (result.status !== 0) throw new Error(`php failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
        return result.stdout;
    }

    // The environment a request gets: the real injectEnv.php, then getenv() for each key.
    function requestEnvironment(root) {
        const code = `require $argv[1]; $out = []; foreach (array_slice($argv, 2) as $k) { $v = getenv($k); `
            + `$out[$k] = $v === false ? null : (string)$v; } echo json_encode($out);`;
        return JSON.parse(php(root, code, [path.join(SERVER_DIR, "injectEnv.php"), ...KEYS]));
    }

    // Save settings the way settings.php does: the real sanitizeSettings(), json_encode,
    // file_put_contents under the upload directory. Returns what a later GET returns.
    function saveSettings(root, settings) {
        const code = `
            require $argv[1];
            $src = file_get_contents($argv[2]);
            $start = strpos($src, 'function sanitizeSettings($settings)');
            $end = strpos($src, "\\n}\\n", $start) + 3;
            eval(substr($src, $start, $end - $start));
            $sanitized = sanitizeSettings(json_decode($argv[3], true));
            $file = $argv[4] . 'settings/1.json';
            file_put_contents($file, json_encode($sanitized, JSON_PRETTY_PRINT), LOCK_EX);
            echo json_encode(sanitizeSettings(json_decode(file_get_contents($file), true)));`;
        return JSON.parse(php(root, code, [
            path.join(SERVER_DIR, "injectEnv.php"),
            path.join(SERVER_DIR, "settings.php"),
            JSON.stringify(settings),
            path.join(root, "upload") + path.sep,
        ]));
    }

    test("the environment is the installation's before and after, and the text comes back as text", () => {
        const root = makeInstallation();
        const envFile = path.join(root, "shared.env.php");
        const envFileBefore = fs.readFileSync(envFile, "utf8");
        const before = requestEnvironment(root);
        expect(before.SITREC_ENABLE_DEFAULT_MAP_SOURCES).toBe("");      // PHP's getenv() form of false
        expect(before.CUSTOM_WIND_URL).toBe(INSTALLATION.CUSTOM_WIND_URL);
        expect(before.NEW_SERVER_SETTING).toBeNull();

        const returned = saveSettings(root, { envOverride: HOSTILE, theme: "dark" });

        // Stored and returned as the text the user typed, nothing more.
        expect(returned).toEqual({ envOverride: HOSTILE, theme: "dark" });
        const stored = JSON.parse(fs.readFileSync(path.join(root, "upload", "settings", "1.json"), "utf8"));
        expect(stored.envOverride).toBe(HOSTILE);

        // A new process, as the next request is: the same environment as before.
        expect(requestEnvironment(root)).toEqual(before);
        // And the configuration file is untouched.
        expect(fs.readFileSync(envFile, "utf8")).toBe(envFileBefore);
        // The save made one file, the settings file.
        expect(fs.readdirSync(root).sort()).toEqual(["shared.env.php", "sitrecServer", "upload"]);
        expect(fs.readdirSync(path.join(root, "sitrecServer"))).toEqual([]);
        expect(fs.readdirSync(path.join(root, "upload", "settings"))).toEqual(["1.json"]);

        fs.rmSync(root, { recursive: true, force: true });
    });
});
