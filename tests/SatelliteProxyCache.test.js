const {spawn, spawnSync} = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const php = spawnSync("php", ["-v"]).status === 0;
const oldCSV = "OBJECT_NAME,NORAD_CAT_ID,EPOCH\nSAMPLE,12345,2025-09-19T00:00:00\n";
const csv = "OBJECT_NAME,NORAD_CAT_ID,EPOCH,DECAY_DATE,COUNTRY_CODE,SITE,GP_ID,FILE,MEAN_ELEMENT_THEORY,EPHEMERIS_TYPE\n"
    + "SAMPLE,12345,2025-09-19T00:00:00,,US,AFETR,123,456,SGP4,0\n";

(php ? describe : describe.skip)("satellite proxy cache", () => {
    let root, server, cache, env;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "satellite-cache-"));
        server = path.join(root, "server"); cache = path.join(root, "cache", "starlink");
        fs.mkdirSync(server); fs.mkdirSync(cache, {recursive: true});
        fs.mkdirSync(path.join(root, "tmp"));
        for (const name of ["proxyStarlink.php", "gpData.php", "gpParquet.php", "gpParquet.py"]) {
            fs.copyFileSync(path.join(__dirname, "../sitrecServer", name), path.join(server, name));
        }
        fs.writeFileSync(path.join(server, "config.php"), "<?php\n");
        fs.writeFileSync(path.join(server, "config_paths.php"), `<?php $CACHE_PATH = ${JSON.stringify(path.join(root, "cache") + "/")};`);
        // A deterministic upstream, reached only on a miss. No network or credentials.
        fs.writeFileSync(path.join(server, "curlGetRequest.php"), `<?php
            function curlConfiguredSourceHeaders($url) { return []; }
            function curlGetRequest($url, $headers, $timeout) {
                file_put_contents(__DIR__ . '/fetches', "fetch\\n", FILE_APPEND | LOCK_EX);
                usleep(250000);
                return ['data' => ${JSON.stringify(csv)}, 'http_status' => 200];
            }
        `);
        env = {...process.env, TMPDIR: path.join(root, "tmp"), SPACEDATA_USERNAME: "", SPACEDATA_PASSWORD: "",
            CUSTOM_TLE: "https://example.test/{YYYY}-{MM}-{DD}.csv", CACHE_CUSTOM_TLE: "1"};
    });
    afterEach(() => fs.rmSync(root, {recursive: true, force: true}));
    const args = (type, days = 2) => ["-r", '$_GET=["request"=>"2025-09-18","type"=>$argv[2],"days"=>$argv[3]]; require $argv[1];', path.join(server, "proxyStarlink.php"), type, String(days)];
    const run = (type, days) => spawnSync("php", args(type, days), {env, encoding: "utf8", timeout: 10000});
    const runAsync = type => new Promise((resolve, reject) => {
        const child = spawn("php", args(type), {env});
        let output = "", errors = "";
        child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { errors += data; });
        child.on("error", reject); child.on("exit", code => code === 0 ? resolve(output) : reject(new Error(errors)));
    });
    function seed(name, age = 0) {
        const file = path.join(cache, name + ".csv.gz");
        fs.writeFileSync(file, zlib.gzipSync(csv));
        const time = new Date(Date.now() - age); fs.utimesSync(file, time, time);
        return file;
    }

    test("repeated historical ALL requests reuse the compressed cache without rewriting it", () => {
        const file = seed("2025-09-18ALL_epochs");
        const before = fs.statSync(file).mtimeMs;
        expect(run("ALL").stdout).toBe(csv); expect(run("ALL").stdout).toBe(csv);
        expect(fs.statSync(file).mtimeMs).toBe(before);
        expect(fs.existsSync(path.join(server, "fetches"))).toBe(false);
    });

    test("an old reduced cache is upgraded on demand, with the old data retained if upstream fails", () => {
        const file = seed("2025-09-18ALL_epochs");
        fs.writeFileSync(file, zlib.gzipSync(oldCSV));
        const result = run("ALL");
        expect(result.stdout).toBe(oldCSV);
        expect(result.stderr).toContain("refresh failed, serving provisional cached copy");
        expect(zlib.gunzipSync(fs.readFileSync(file)).toString()).toBe(oldCSV);
        seed("2025-09-18ALL_epochs");
        const upgraded = run("ALL");
        expect(upgraded.stdout).toBe(csv);
        expect(upgraded.stderr).toBe("");
    });

    test("current data expires after one hour and falls back to the intact old file on upstream failure", () => {
        const file = seed("current_all");
        const fresh = run("CURRENT"); expect(fresh.stdout).toBe(csv); expect(fresh.stderr).toBe("");
        const old = new Date(Date.now() - 3601000); fs.utimesSync(file, old, old);
        const stale = run("CURRENT"); expect(stale.stdout).toBe(csv);
        expect(stale.stderr).toContain("refresh failed, serving provisional cached copy");
        expect(zlib.gunzipSync(fs.readFileSync(file)).toString()).toBe(csv);
    });

    test("two simultaneous misses fetch once and both receive a complete catalog", async () => {
        expect(await Promise.all([runAsync("CUSTOM"), runAsync("CUSTOM")])).toEqual([csv, csv]);
        expect(fs.readFileSync(path.join(server, "fetches"), "utf8")).toBe("fetch\n");
        expect(run("CUSTOM").stdout).toBe(csv);
        expect(fs.readFileSync(path.join(server, "fetches"), "utf8")).toBe("fetch\n");
        expect(fs.readdirSync(cache).filter(name => name.startsWith(".gp-"))).toEqual([]);
    });

    test("a wider historical window uses its own cache entry", () => {
        seed("2025-09-18ALL_d6_epochs");
        expect(run("ALL", 6).stdout).toBe(csv);
        expect(run("ALL", 2).stdout).toContain("credentials not configured");
    });
});
