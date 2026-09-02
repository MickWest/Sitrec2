/**
 * Tests for sitrecServer/s3_client.php: the pure client-config builder and the
 * unsigned object URL.
 *
 * PHP is driven as a child process through a small harness written to a temp
 * directory. The whole file skips cleanly when php is not on PATH or the AWS SDK
 * has not been installed (sitrecServer/vendor/autoload.php missing).
 *
 * The URL-parity test is the important one: s3ObjectUrl() keeps the historical
 * string form for the plain commercial case so existing deployments hand out
 * byte-identical URLs, and this test proves the SDK's getObjectUrl() would produce
 * the same string, so the two forms cannot drift apart unnoticed.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SERVER_DIR = path.join(ROOT, "sitrecServer");
const AUTOLOAD = path.join(SERVER_DIR, "vendor", "autoload.php");

function phpOnPath() {
    const r = spawnSync("php", ["-v"], { encoding: "utf8" });
    return r.status === 0;
}

const canRun = phpOnPath() && fs.existsSync(AUTOLOAD);

// PHP's rawurlencode (RFC 3986): everything except unreserved characters. JS's
// encodeURIComponent leaves !'()* alone, so they are encoded here by hand.
function rawurlencode(s) {
    return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function legacyUrl(bucket, region, key) {
    return "https://" + bucket + ".s3." + region + ".amazonaws.com/" + key.split("/").map(rawurlencode).join("/");
}

// The harness: mode "configs" prints buildS3ClientConfig() for every case in the
// JSON argument; mode "urls" applies one env map with putenv(), then prints
// s3ObjectUrl() and the SDK's getObjectUrl() for every key.
const HARNESS = `<?php
require_once $argv[1] . '/s3_client.php';
$mode = $argv[2];
$input = json_decode($argv[3], true);
$out = [];
if ($mode === 'configs') {
    foreach ($input as $name => $env) {
        try {
            $out[$name] = buildS3ClientConfig($env);
        } catch (Exception $e) {
            $out[$name] = ['exception' => get_class($e), 'message' => $e->getMessage()];
        }
    }
} elseif ($mode === 'urls') {
    foreach ($input['env'] as $name => $value) {
        putenv($name . '=' . $value);
    }
    $client = createS3Client(buildS3ClientConfig($input['env']));
    foreach ($input['keys'] as $key) {
        $out[$key] = [
            'sitrec' => s3ObjectUrl($input['bucket'], $key),
            'sdk' => $client->getObjectUrl($input['bucket'], $key),
        ];
    }
    $out['__hasCredentials'] = s3HasCredentials();
}
echo json_encode($out);
`;

let harnessPath = null;

function runHarness(mode, input) {
    const r = spawnSync(
        "php",
        ["-d", "display_errors=stderr", harnessPath, SERVER_DIR, mode, JSON.stringify(input)],
        { cwd: SERVER_DIR, encoding: "utf8", maxBuffer: 1 << 24 }
    );
    if (r.status !== 0) {
        throw new Error("php harness failed (" + r.status + "):\n" + r.stdout + "\n" + r.stderr);
    }
    return JSON.parse(r.stdout);
}

if (!canRun) {
    test.skip("s3_client.php: needs php on PATH and sitrecServer/vendor/autoload.php (run composer install in sitrecServer)", () => {});
} else {
    beforeAll(() => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sitrec-s3client-"));
        harnessPath = path.join(dir, "harness.php");
        fs.writeFileSync(harnessPath, HARNESS);
    });

    describe("buildS3ClientConfig", () => {
        const STATIC = { S3_ACCESS_KEY_ID: "AKIAEXAMPLE", S3_SECRET_ACCESS_KEY: "secretExample" };
        let cfg;

        beforeAll(() => {
            cfg = runHarness("configs", {
                commercial: { S3_REGION: "us-west-2", ...STATIC },
                fipsDefault: { S3_REGION: "us-gov-west-1", ...STATIC },
                fipsOff: { S3_REGION: "us-gov-west-1", S3_USE_FIPS: "false", ...STATIC },
                fipsOffInjected: { S3_REGION: "us-gov-west-1", S3_USE_FIPS: "", ...STATIC },
                fipsOn: { S3_REGION: "us-west-2", S3_USE_FIPS: "true", ...STATIC },
                fipsOnInjected: { S3_REGION: "us-west-2", S3_USE_FIPS: "1", ...STATIC },
                role: { S3_REGION: "us-west-2", S3_CREDENTIAL_SOURCE: "role" },
                roleIgnoresKeys: { S3_REGION: "us-west-2", S3_CREDENTIAL_SOURCE: "role", ...STATIC },
                anonymous: { S3_REGION: "us-west-2", S3_CREDENTIAL_SOURCE: "anonymous", ...STATIC },
                noKeysNoSource: { S3_REGION: "us-west-2" },
                staticWithoutKeys: { S3_REGION: "us-west-2", S3_CREDENTIAL_SOURCE: "static" },
                endpoint: { S3_REGION: "us-west-2", S3_ENDPOINT: "https://objects.example.internal:9000", ...STATIC },
                endpointVirtualHosted: { S3_REGION: "us-west-2", S3_ENDPOINT: "https://objects.example.internal:9000", S3_USE_PATH_STYLE: "false", ...STATIC },
                pathStyleWithoutEndpoint: { S3_REGION: "us-west-2", S3_USE_PATH_STYLE: "true", ...STATIC },
                badSource: { S3_REGION: "us-west-2", S3_CREDENTIAL_SOURCE: "keychain", ...STATIC },
            });
        });

        test("commercial static case is exactly what every deployment builds today", () => {
            expect(cfg.commercial).toEqual({
                version: "latest",
                region: "us-west-2",
                use_fips_endpoint: false,
                credentials: ["static", "AKIAEXAMPLE", "secretExample"],
                credentialSource: "static",
            });
        });

        test("FIPS defaults on for a us-gov- region and can be switched off explicitly", () => {
            expect(cfg.fipsDefault.use_fips_endpoint).toBe(true);
            expect(cfg.fipsOff.use_fips_endpoint).toBe(false);
            // injectEnv.php hands an unquoted `false` to getenv() as ""
            expect(cfg.fipsOffInjected.use_fips_endpoint).toBe(false);
        });

        test("FIPS can be switched on in any region", () => {
            expect(cfg.fipsOn.use_fips_endpoint).toBe(true);
            expect(cfg.fipsOnInjected.use_fips_endpoint).toBe(true);
        });

        test("role: no credentials key at all, so the SDK's default provider chain runs", () => {
            expect(cfg.role.credentialSource).toBe("role");
            expect("credentials" in cfg.role).toBe(false);
            expect(cfg.roleIgnoresKeys.credentialSource).toBe("role");
            expect("credentials" in cfg.roleIgnoresKeys).toBe(false);
        });

        test("anonymous: credentials => false", () => {
            expect(cfg.anonymous.credentialSource).toBe("anonymous");
            expect(cfg.anonymous.credentials).toBe(false);
        });

        test("no keys and no source stays anonymous (the pre-existing keyless behaviour)", () => {
            expect(cfg.noKeysNoSource.credentialSource).toBe("anonymous");
            expect(cfg.noKeysNoSource.credentials).toBe(false);
            expect(cfg.staticWithoutKeys.credentialSource).toBe("anonymous");
        });

        test("custom endpoint: path style on by default, off on request, ignored without an endpoint", () => {
            expect(cfg.endpoint.endpoint).toBe("https://objects.example.internal:9000");
            expect(cfg.endpoint.use_path_style_endpoint).toBe(true);
            expect(cfg.endpointVirtualHosted.use_path_style_endpoint).toBe(false);
            expect("endpoint" in cfg.pathStyleWithoutEndpoint).toBe(false);
            expect("use_path_style_endpoint" in cfg.pathStyleWithoutEndpoint).toBe(false);
            expect("endpoint" in cfg.commercial).toBe(false);
        });

        test("an unknown S3_CREDENTIAL_SOURCE is refused", () => {
            expect(cfg.badSource.exception).toBe("InvalidArgumentException");
        });
    });

    describe("s3ObjectUrl", () => {
        const BUCKET = "sitrec";
        const KEYS = [
            "1/Agua Redux Object Tracked/20260829_232554.js",
            "99999999/a (b)+c%d/é.js",
            "7/x/y/z.mp4",
        ];
        const STATIC = { S3_ACCESS_KEY_ID: "AKIAEXAMPLE", S3_SECRET_ACCESS_KEY: "secretExample" };

        test("commercial case: byte-identical to the legacy string, and the SDK agrees", () => {
            const out = runHarness("urls", { env: { S3_REGION: "us-west-2", ...STATIC }, bucket: BUCKET, keys: KEYS });
            expect(out.__hasCredentials).toBe(true);
            for (const key of KEYS) {
                const expected = legacyUrl(BUCKET, "us-west-2", key);
                expect(out[key].sitrec).toBe(expected);
                expect(out[key].sdk).toBe(expected);
            }
        });

        test("FIPS case: host is bucket.s3-fips.<region>", () => {
            const out = runHarness("urls", { env: { S3_REGION: "us-west-2", S3_USE_FIPS: "true", ...STATIC }, bucket: BUCKET, keys: KEYS });
            for (const key of KEYS) {
                expect(out[key].sitrec.startsWith("https://sitrec.s3-fips.us-west-2.amazonaws.com/")).toBe(true);
                expect(out[key].sitrec).toBe(out[key].sdk);
                // the key encoding is the same as the legacy form
                expect(out[key].sitrec.slice("https://sitrec.s3-fips.us-west-2.amazonaws.com/".length))
                    .toBe(key.split("/").map(rawurlencode).join("/"));
            }
        });

        test("custom endpoint case: endpoint host, path style, bucket in the path", () => {
            const out = runHarness("urls", {
                env: { S3_REGION: "us-west-2", S3_ENDPOINT: "https://objects.example.internal:9000", ...STATIC },
                bucket: BUCKET,
                keys: KEYS,
            });
            for (const key of KEYS) {
                expect(out[key].sitrec.startsWith("https://objects.example.internal:9000/sitrec/")).toBe(true);
                expect(out[key].sitrec).toBe(out[key].sdk);
            }
        });

        test("anonymous install still builds the same commercial URL without credentials", () => {
            const out = runHarness("urls", { env: { S3_REGION: "us-west-2" }, bucket: BUCKET, keys: KEYS });
            expect(out.__hasCredentials).toBe(false);
            for (const key of KEYS) {
                expect(out[key].sitrec).toBe(legacyUrl(BUCKET, "us-west-2", key));
            }
        });
    });
}
