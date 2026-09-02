/**
 * S3_READS_VIA_SERVER: with it set, object.php and rehost.php hand the browser a same-origin
 * s3-proxy.php URL for every object instead of a storage URL (presigned or public), for
 * deployments whose browsers cannot reach the storage endpoint. The switch and the URL
 * builder live in sitrecServer/object_helpers.php and take optional arguments so they can
 * be exercised here without a web server. Skips when php is not installed.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const SERVER_DIR = path.resolve(__dirname, "..", "sitrecServer");

function phpAvailable() {
    const r = spawnSync("php", ["-v"], { encoding: "utf8" });
    return r.status === 0;
}

function runPhp(code) {
    const r = spawnSync("php", ["-d", "display_errors=stderr", "-r", code], { encoding: "utf8", cwd: SERVER_DIR });
    if (r.status !== 0) {
        throw new Error(`php failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
    }
    return JSON.parse(r.stdout);
}

const describeIfPhp = phpAvailable() ? describe : describe.skip;

describeIfPhp("S3_READS_VIA_SERVER", () => {
    test("is off unless set, and accepts the usual true spellings", () => {
        const out = runPhp(`
            require __DIR__ . '/object_helpers.php';
            echo json_encode([
                'unset'  => s3ReadsViaServer([]),
                'empty'  => s3ReadsViaServer(['S3_READS_VIA_SERVER' => '']),
                'false'  => s3ReadsViaServer(['S3_READS_VIA_SERVER' => 'false']),
                'zero'   => s3ReadsViaServer(['S3_READS_VIA_SERVER' => '0']),
                'true'   => s3ReadsViaServer(['S3_READS_VIA_SERVER' => 'true']),
                'one'    => s3ReadsViaServer(['S3_READS_VIA_SERVER' => '1']),
                'yes'    => s3ReadsViaServer(['S3_READS_VIA_SERVER' => 'YES']),
                'bool'   => s3ReadsViaServer(['S3_READS_VIA_SERVER' => true]),
            ]);
        `.replace(/__DIR__/g, JSON.stringify(SERVER_DIR)));
        expect(out).toEqual({ unset: false, empty: false, false: false, zero: false, true: true, one: true, yes: true, bool: true });
    });

    test("the same-origin URL is s3-proxy.php on the application with the key encoded once", () => {
        const out = runPhp(`
            require __DIR__ . '/object_helpers.php';
            echo json_encode([
                'plain'   => buildServerObjectUrl('42/My Sitch/20260902_120000_9f3a1c7b4e2d.js', 'https://sitrec.example.test/'),
                'noslash' => buildServerObjectUrl('42/a+b%c/v.mp4', 'https://sitrec.example.test/sitrec'),
            ]);
        `.replace(/__DIR__/g, JSON.stringify(SERVER_DIR)));
        expect(out.plain).toBe("https://sitrec.example.test/sitrecServer/s3-proxy.php?key=42%2FMy%20Sitch%2F20260902_120000_9f3a1c7b4e2d.js");
        expect(out.noslash).toBe("https://sitrec.example.test/sitrec/sitrecServer/s3-proxy.php?key=42%2Fa%2Bb%25c%2Fv.mp4");
    });
});
