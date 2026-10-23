/**
 * s3-proxy.php must never serve an object as active content on the application's origin.
 *
 * A presigned PUT does not sign Content-Type, so the uploader chooses the type stored with
 * the object. The proxy used to copy that stored type into its response, so an upload stored
 * as text/html (or SVG, XHTML, XML) ran script on this origin. The response type now comes
 * from the key's extension (objectProxyContentHeaders in object_helpers.php): real types
 * for images, video and audio, text/plain or JSON for text data, application/octet-stream
 * for everything else, an attachment for everything that is not media, and nosniff always.
 *
 * The first block tests the helper with php -r. The second runs the real s3-proxy.php under
 * php-cgi with stub configuration and storage, through both fetch paths: the SDK path (stub
 * client) and the unsigned cURL path (a local HTTP server standing in for storage). Skips
 * when php / php-cgi is not installed.
 */
const {spawn, spawnSync} = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const SERVER_DIR = path.resolve(__dirname, "..", "sitrecServer");

const php = spawnSync("php", ["-v"], {encoding: "utf8"}).status === 0;
const phpCgi = spawnSync("php-cgi", ["-v"], {encoding: "utf8"}).status === 0;

const TEXT = "text/plain; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";
const BINARY = "application/octet-stream";

// key => [Content-Type, sent as an attachment?]
const EXPECTED = {
    "42/a.png": ["image/png", false],
    "42/a.PNG": ["image/png", false],
    "42/photo.JPG": ["image/jpeg", false],
    "42/a.jpeg": ["image/jpeg", false],
    "42/a.gif": ["image/gif", false],
    "42/a.webp": ["image/webp", false],
    "42/a.bmp": ["image/bmp", false],
    "42/a.tif": ["image/tiff", false],
    "42/a.heic": ["image/heic", false],
    "42/Sitch/screenshot_20260902_120000.jpg": ["image/jpeg", false],
    "42/v.mp4": ["video/mp4", false],
    "42/v.MOV": ["video/quicktime", false],
    "42/v.webm": ["video/webm", false],
    "42/v.mpg": ["video/mpeg", false],
    "42/s.ts": ["video/mp2t", false],
    "42/a.mp3": ["audio/mpeg", false],
    "42/a.m4a": ["audio/mp4", false],
    "42/a.wav": ["audio/wav", false],
    "42/My Sitch/20260902_120000_9f3a1c7b4e2d.js": [TEXT, true],
    "42/t.json": [JSON_TYPE, true],
    "42/t.geojson": [JSON_TYPE, true],
    "42/t.kml": [TEXT, true],
    "42/t.ksv": [TEXT, true],
    "42/t.xml": [TEXT, true],
    "42/t.CSV": [TEXT, true],
    "42/t.txt": [TEXT, true],
    "42/s.pts.txt": [TEXT, true],
    "42/t.tle": [TEXT, true],
    "42/t.2le": [TEXT, true],
    "42/t.3le": [TEXT, true],
    "42/t.srt": [TEXT, true],
    // Active or unknown types fall through to a download.
    "42/a.html": [BINARY, true],
    "42/a.HTM": [BINARY, true],
    "42/a.svg": [BINARY, true],
    "42/a.xhtml": [BINARY, true],
    "42/a.xht": [BINARY, true],
    "42/a.mjs": [BINARY, true],
    "42/a.xsl": [BINARY, true],
    "42/a.glb": [BINARY, true],
    "42/a.kmz": [BINARY, true],
    // Only the last extension of the last path segment counts.
    "42/a.png.html": [BINARY, true],
    "42/a.kml.svg": [BINARY, true],
    "42/a.html.png": ["image/png", false],
    "42/a.html.json": [JSON_TYPE, true],
    "42/noextension": [BINARY, true],
    "42/folder.png/noextension": [BINARY, true],
    "42/trailingdot.": [BINARY, true],
    "42/a.png%3Cscript%3E": [BINARY, true],
};

// Never a type a browser renders as a document or runs as script.
const ACTIVE_TYPE = /html|xml|svg|javascript|ecmascript/i;

(php ? describe : describe.skip)("objectProxyContentHeaders", () => {
    test("the type comes from the key's last extension, with nosniff always and an attachment unless media", () => {
        const r = spawnSync("php", ["-d", "display_errors=stderr", "-r", `
            require ${JSON.stringify(path.join(SERVER_DIR, "object_helpers.php"))};
            $out = [];
            foreach (json_decode(getenv('TEST_KEYS'), true) as $key) $out[$key] = objectProxyContentHeaders($key);
            echo json_encode($out);
        `], {encoding: "utf8", cwd: SERVER_DIR, env: {...process.env, TEST_KEYS: JSON.stringify(Object.keys(EXPECTED))}});
        if (r.status !== 0) throw new Error(`php failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
        const out = JSON.parse(r.stdout);

        for (const [key, [type, attachment]] of Object.entries(EXPECTED)) {
            const headers = out[key];
            expect({key, type: headers["Content-Type"]}).toEqual({key, type});
            expect({key, nosniff: headers["X-Content-Type-Options"]}).toEqual({key, nosniff: "nosniff"});
            expect({key, disposition: headers["Content-Disposition"]})
                .toEqual({key, disposition: attachment ? "attachment" : undefined});
            expect(headers["Content-Type"]).not.toMatch(ACTIVE_TYPE);
            expect(Object.keys(headers)[0]).toBe("Content-Type");
        }
    });
});

// Stand-ins for configuration and storage; s3-proxy.php, object_helpers.php and audit.php
// are the real files. The SDK stub returns whatever stored type TEST_STORED_TYPE names
// (none when empty), and honours a Range the way S3 does.
const STUBS = {
    "config.php": "<?php\n$s3creds = ['bucket' => 'example-bucket', 'region' => 'example-region'];\n",
    "config_paths.php": "<?php\n$APP_URL = 'https://example.test/';\n",
    "s3_client.php": `<?php
function s3HasCredentials() { return getenv('TEST_FETCH_PATH') === 'sdk'; }
function s3ObjectUrl($bucket, $key) { return getenv('TEST_UPSTREAM') . '/' . rawurlencode($key); }
function getS3Client() {
    return new class {
        function getObject($params) {
            $body = '<script>document.title = "ran"</script>';
            $result = ['@metadata' => ['statusCode' => 200], 'ContentLength' => strlen($body), 'AcceptRanges' => 'bytes'];
            if (isset($params['Range'])) {
                $result = ['@metadata' => ['statusCode' => 206], 'ContentLength' => 8,
                    'ContentRange' => 'bytes 0-7/' . strlen($body), 'AcceptRanges' => 'bytes'];
                $body = substr($body, 0, 8);
            }
            if (getenv('TEST_STORED_TYPE') !== '') $result['ContentType'] = getenv('TEST_STORED_TYPE');
            $result['Body'] = new class($body) {
                private $body;
                function __construct($body) { $this->body = $body; }
                function eof() { return $this->body === ''; }
                function read($n) { $chunk = substr($this->body, 0, $n); $this->body = (string)substr($this->body, $n); return $chunk; }
            };
            return $result;
        }
    };
}
`,
};

const STORED_TYPES = ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml",
    "application/javascript", ""];
const BODY = '<script>document.title = "ran"</script>';

(phpCgi ? describe : describe.skip)("s3-proxy.php response type", () => {
    let root;
    let script;
    let upstream;
    let upstreamUrl;
    // The type the stand-in storage returns for the next cURL-path request, as an
    // uploader-chosen stored type would be. Empty sends no Content-Type at all.
    let upstreamStoredType = "";

    beforeAll(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "sitrec-s3proxy-"));
        fs.mkdirSync(path.join(root, "sitrecServer"));
        for (const name of ["s3-proxy.php", "object_helpers.php", "audit.php"]) {
            fs.copyFileSync(path.join(SERVER_DIR, name), path.join(root, "sitrecServer", name));
        }
        for (const [name, content] of Object.entries(STUBS)) {
            fs.writeFileSync(path.join(root, "sitrecServer", name), content);
        }
        script = path.join(root, "sitrecServer", "s3-proxy.php");

        // Storage for the unsigned cURL path.
        upstream = http.createServer((req, res) => {
            if (req.url.endsWith("missing.json")) {
                res.writeHead(404, {"Content-Type": "application/xml"});
                res.end("<Error><Code>NoSuchKey</Code></Error>");
                return;
            }
            const headers = upstreamStoredType ? {"Content-Type": upstreamStoredType} : {};
            if (req.headers.range) {
                res.writeHead(206, {...headers, "Content-Range": `bytes 0-7/${BODY.length}`,
                    "Content-Length": "8", "Accept-Ranges": "bytes"});
                res.end(BODY.slice(0, 8));
                return;
            }
            res.writeHead(200, {...headers, "Content-Length": String(BODY.length), "Accept-Ranges": "bytes"});
            res.end(BODY);
        });
        await new Promise((resolve, reject) => {
            upstream.once("error", reject);
            upstream.listen(0, "127.0.0.1", resolve);
        });
        upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
    });

    afterAll(async () => {
        if (upstream) await new Promise(resolve => upstream.close(resolve));
        if (root) fs.rmSync(root, {recursive: true, force: true});
    });

    // One GET through php-cgi. Asynchronous, so the stand-in storage above can answer.
    function get(key, {fetchPath, storedType = "", range = null}) {
        const env = {};
        for (const [name, value] of Object.entries(process.env)) {
            // A proxy setting would send the cURL path somewhere other than the stand-in.
            if (!/_proxy$/i.test(name)) env[name] = value;
        }
        Object.assign(env, {
            REDIRECT_STATUS: "1",
            REQUEST_METHOD: "GET",
            SCRIPT_FILENAME: script,
            QUERY_STRING: "key=" + encodeURIComponent(key),
            REQUEST_SCHEME: "https",
            HTTP_HOST: "example.test",
            AUTH_MODE: "",
            AUDIT_LOG_ENABLED: "false",
            TEST_FETCH_PATH: fetchPath,
            TEST_STORED_TYPE: storedType,
            TEST_UPSTREAM: upstreamUrl,
        });
        if (range) env.HTTP_RANGE = range;
        upstreamStoredType = storedType;
        return new Promise((resolve, reject) => {
            const child = spawn("php-cgi", ["-d", "display_errors=0", "-d", "log_errors=0"], {env});
            let stdout = "";
            let stderr = "";
            child.stdout.setEncoding("latin1");
            child.stdout.on("data", chunk => { stdout += chunk; });
            child.stderr.on("data", chunk => { stderr += chunk; });
            child.once("error", reject);
            child.once("close", code => {
                if (code !== 0) return reject(new Error(`php-cgi exited ${code}: ${stderr}`));
                const split = stdout.search(/\r?\n\r?\n/);
                const headers = {};
                for (const line of stdout.slice(0, split).split(/\r?\n/)) {
                    const colon = line.indexOf(":");
                    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
                }
                const status = headers.status ? parseInt(headers.status, 10) : 200;
                resolve({status, headers, body: stdout.slice(split).replace(/^\r?\n\r?\n/, "")});
            });
        });
    }

    describe.each(["sdk", "curl"])("%s fetch path", (fetchPath) => {
        test("a stored active type is never sent, whatever the key", async () => {
            for (const storedType of STORED_TYPES) {
                for (const key of ["42/a-0123.html", "42/a.svg", "42/a.png.html", "42/noextension"]) {
                    const res = await get(key, {fetchPath, storedType});
                    const seen = {key, storedType, status: res.status, type: res.headers["content-type"],
                        disposition: res.headers["content-disposition"], nosniff: res.headers["x-content-type-options"]};
                    expect(seen).toEqual({key, storedType, status: 200, type: BINARY,
                        disposition: "attachment", nosniff: "nosniff"});
                    expect(res.body).toBe(BODY);
                }
            }
        });

        test("media and data keys get their own type even when the stored type is text/html", async () => {
            const cases = {
                "42/a.png": ["image/png", undefined],
                "42/a.html.png": ["image/png", undefined],
                "42/v.MP4": ["video/mp4", undefined],
                "42/a.mp3": ["audio/mpeg", undefined],
                "42/My Sitch/20260902_120000_9f3a1c7b4e2d.js": [TEXT, "attachment"],
                "42/t.json": [JSON_TYPE, "attachment"],
                "42/t.kml": [TEXT, "attachment"],
                "42/t.xml": [TEXT, "attachment"],
            };
            for (const [key, [type, disposition]] of Object.entries(cases)) {
                const res = await get(key, {fetchPath, storedType: "text/html"});
                expect({key, status: res.status, type: res.headers["content-type"],
                    disposition: res.headers["content-disposition"], nosniff: res.headers["x-content-type-options"]})
                    .toEqual({key, status: 200, type, disposition, nosniff: "nosniff"});
                expect(res.body).toBe(BODY);
            }
        });

        test("range requests keep their status, range headers and caching", async () => {
            const res = await get("42/v.mp4", {fetchPath, storedType: "text/html", range: "bytes=0-7"});
            expect(res.status).toBe(206);
            expect(res.headers["content-type"]).toBe("video/mp4");
            expect(res.headers["content-range"]).toBe(`bytes 0-7/${BODY.length}`);
            expect(res.headers["accept-ranges"]).toBe("bytes");
            expect(res.headers["content-length"]).toBe("8");
            expect(res.headers["cache-control"]).toBe("public, max-age=300");
            expect(res.body).toBe(BODY.slice(0, 8));
        });
    });

    test("an upstream error keeps its status and is not sent as XML", async () => {
        const res = await get("42/missing.json", {fetchPath: "curl"});
        expect(res.status).toBe(404);
        expect(res.headers["content-type"]).toBe(JSON_TYPE);
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    test("key validation is unchanged", async () => {
        for (const key of ["", "notnumeric/a.png", "42/../a.png"]) {
            const res = await get(key, {fetchPath: "sdk"});
            expect({key, status: res.status}).toEqual({key, status: 400});
        }
    });
});
