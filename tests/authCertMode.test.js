/**
 * Client certificate authentication mode (AUTH_MODE=cert) for the PHP backend.
 *
 * Exercises the REAL config/config.php.example and sitrecServer/auth_cert.php through
 * the php CLI, against a throw-away certificate authority minted with the openssl CLI:
 * root -> intermediate -> leaves, plus an unrelated second root. Skips cleanly when
 * php or openssl is not on PATH.
 *
 * Three PHP entry points are written to a temp dir:
 *   harness.php - sets $_SERVER from stdin JSON, requires config.php, prints getUserInfoCustom()
 *   direct.php  - calls resolveCertIdentity() directly (returns the identifier too)
 *   cidr.php    - the trusted-proxy address matcher
 * injectEnv.php is stubbed to an empty file so getenv() reads the process environment
 * handed to php by each case.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");

function toolAvailable(cmd, args) {
    try {
        const r = spawnSync(cmd, args, { encoding: "utf8" });
        return r.status === 0;
    } catch (e) {
        return false;
    }
}

const havePhp = toolAvailable("php", ["--version"]);
const haveOpenssl = toolAvailable("openssl", ["version"]);
const describeIfTools = havePhp && haveOpenssl ? describe : describe.skip;
if (!havePhp || !haveOpenssl) {
    console.warn("authCertMode: php or openssl not on PATH; skipping");
}

// The process environment minus anything that would steer identity resolution.
function cleanEnv() {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (/^(AUTH_|SITREC_DEFAULT_|XENFORO_)/.test(k)) continue;
        env[k] = v;
    }
    return env;
}

function openssl(args, cwd) {
    const r = spawnSync("openssl", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) {
        throw new Error(`openssl ${args.join(" ")} failed:\n${r.stderr}`);
    }
    return r.stdout;
}

// Mirror the proxy header: URL-encoded PEM with "+", "=" and "/" left as they are.
function headerEncode(pem) {
    return encodeURIComponent(pem).replace(/%2B/g, "+").replace(/%3D/g, "=").replace(/%2F/g, "/");
}

const HEADER_KEY = "HTTP_X_AMZN_MTLS_CLIENTCERT_LEAF";

describeIfTools("AUTH_MODE=cert: client certificate authentication", () => {
    let tmp;          // temp root
    let serverDir;    // <tmp>/sitrecServer
    let pki;          // <tmp>/pki
    let certs = {};   // name -> PEM text
    let bundlePath;
    let userMapPath;
    let daveMinted = false;

    function leaf(name, subject, extLines, caKey = "inter.key", caCert = "inter.crt") {
        openssl(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
            "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", subject], pki);
        fs.writeFileSync(path.join(pki, `${name}.ext`), extLines.join("\n") + "\n");
        openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial",
            "-out", `${name}.crt`, "-days", "365", "-extfile", `${name}.ext`], pki);
        certs[name] = fs.readFileSync(path.join(pki, `${name}.crt`), "utf8");
    }

    beforeAll(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sitrec-authcert-"));
        serverDir = path.join(tmp, "sitrecServer");
        pki = path.join(tmp, "pki");
        fs.mkdirSync(serverDir);
        fs.mkdirSync(pki);

        // The real files under test, beside a stub injectEnv.php.
        fs.copyFileSync(path.join(REPO, "config", "config.php.example"), path.join(serverDir, "config.php"));
        fs.copyFileSync(path.join(REPO, "sitrecServer", "auth_cert.php"), path.join(serverDir, "auth_cert.php"));
        fs.copyFileSync(path.join(REPO, "sitrecServer", "audit.php"), path.join(serverDir, "audit.php"));
        fs.writeFileSync(path.join(serverDir, "injectEnv.php"), "<?php\n");
        fs.writeFileSync(path.join(serverDir, "harness.php"), [
            "<?php",
            "$in = json_decode(file_get_contents('php://stdin'), true);",
            "$_SERVER = array_merge($_SERVER, is_array($in) ? $in : []);",
            "require __DIR__ . '/config.php';",
            "echo json_encode(getUserInfoCustom());",
            "",
        ].join("\n"));
        fs.writeFileSync(path.join(serverDir, "direct.php"), [
            "<?php",
            "require __DIR__ . '/auth_cert.php';",
            "$in = json_decode(file_get_contents('php://stdin'), true);",
            "$r = resolveCertIdentity($in['server'], $in['env']);",
            "echo json_encode(['result' => $r, 'log' => authCertLogLine($r)]);",
            "",
        ].join("\n"));
        fs.writeFileSync(path.join(serverDir, "cidr.php"), [
            "<?php",
            "require __DIR__ . '/auth_cert.php';",
            "$in = json_decode(file_get_contents('php://stdin'), true);",
            "$out = [];",
            "foreach ($in as $pair) { $out[] = authCertIpInList($pair[0], $pair[1]); }",
            "echo json_encode($out);",
            "",
        ].join("\n"));

        // --- A tiny authority: root -> intermediate -> leaves, plus an unrelated root ---
        const caExt = ["basicConstraints=critical,CA:TRUE", "keyUsage=critical,keyCertSign,cRLSign"];
        openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
            "-keyout", "root.key", "-out", "root.crt", "-days", "3650", "-subj", "/CN=Test Root/O=Example",
            "-addext", caExt[0], "-addext", caExt[1]], pki);
        openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
            "-keyout", "other.key", "-out", "other.crt", "-days", "3650", "-subj", "/CN=Other Root/O=Example",
            "-addext", caExt[0], "-addext", caExt[1]], pki);

        openssl(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
            "-keyout", "inter.key", "-out", "inter.csr", "-subj", "/CN=Test Intermediate/O=Example"], pki);
        fs.writeFileSync(path.join(pki, "inter.ext"), [
            "basicConstraints=critical,CA:TRUE,pathlen:0",
            "keyUsage=critical,keyCertSign,cRLSign",
            "subjectKeyIdentifier=hash",
            "authorityKeyIdentifier=keyid:always",
            "",
        ].join("\n"));
        openssl(["x509", "-req", "-in", "inter.csr", "-CA", "root.crt", "-CAkey", "root.key", "-CAcreateserial",
            "-out", "inter.crt", "-days", "3650", "-extfile", "inter.ext"], pki);

        bundlePath = path.join(pki, "bundle.pem");
        fs.writeFileSync(bundlePath,
            fs.readFileSync(path.join(pki, "root.crt"), "utf8") + fs.readFileSync(path.join(pki, "inter.crt"), "utf8"));

        const clientExt = ["basicConstraints=CA:FALSE", "keyUsage=digitalSignature", "extendedKeyUsage=clientAuth"];
        leaf("alice", "/CN=SMITH.ALEX.Q.1234567890/O=Example",
            [...clientExt, "subjectAltName=email:alice.1234567890@example.org"]);
        leaf("bob-signature", "/CN=SMITH.ALEX.Q.1234567890/O=Example",
            ["basicConstraints=CA:FALSE", "keyUsage=digitalSignature", "extendedKeyUsage=emailProtection",
                "subjectAltName=email:alice.1234567890@example.org"]);
        leaf("carol-policy", "/CN=JONES.CAROL.R.2222222222/O=Example",
            [...clientExt, "certificatePolicies=1.3.6.1.4.1.99999.1.1",
                "subjectAltName=email:carol.2222222222@example.org"]);
        leaf("mallory", "/CN=SMITH.ALEX.Q.1234567890/O=Example",
            [...clientExt, "subjectAltName=email:alice.1234567890@example.org"], "other.key", "other.crt");

        // dave-expired: "openssl x509 -req" cannot set explicit dates on every version, so
        // sign with "openssl ca", which has always taken -startdate/-enddate.
        try {
            fs.mkdirSync(path.join(pki, "ca", "newcerts"), { recursive: true });
            fs.writeFileSync(path.join(pki, "ca", "index.txt"), "");
            fs.writeFileSync(path.join(pki, "ca", "serial"), "1000\n");
            fs.writeFileSync(path.join(pki, "ca.cnf"), [
                "[ ca ]", "default_ca = CA_default",
                "[ CA_default ]", "dir = ./ca", "database = $dir/index.txt", "new_certs_dir = $dir/newcerts",
                "serial = $dir/serial", "private_key = ./inter.key", "certificate = ./inter.crt",
                "default_md = sha256", "policy = policy_any", "unique_subject = no", "copy_extensions = none",
                "[ policy_any ]", "commonName = supplied", "organizationName = optional", "",
            ].join("\n"));
            openssl(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
                "-keyout", "dave-expired.key", "-out", "dave-expired.csr",
                "-subj", "/CN=SMITH.ALEX.Q.1234567890/O=Example"], pki);
            fs.writeFileSync(path.join(pki, "dave-expired.ext"),
                [...clientExt, "subjectAltName=email:alice.1234567890@example.org", ""].join("\n"));
            openssl(["ca", "-config", "ca.cnf", "-batch", "-notext", "-in", "dave-expired.csr",
                "-out", "dave-expired.crt", "-startdate", "20200101000000Z", "-enddate", "20210101000000Z",
                "-extfile", "dave-expired.ext"], pki);
            certs["dave-expired"] = fs.readFileSync(path.join(pki, "dave-expired.crt"), "utf8");
            daveMinted = true;
        } catch (e) {
            console.warn("authCertMode: could not mint an expired certificate with this openssl; skipping that case\n" + e.message);
        }

        // Identity mapping: both identifiers the default sources yield for alice, and carol.
        userMapPath = path.join(tmp, "users.json");
        fs.writeFileSync(userMapPath, JSON.stringify({
            "1234567890": { user_id: 42, groups: [2, 14] },
            "alice.1234567890": { user_id: 42, groups: [2, 14] },
            "2222222222": { user_id: 43, groups: [2] },
            "carol.2222222222": { user_id: 43, groups: [2] },
        }));
    }, 120000);

    afterAll(() => {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });

    // Settings that make a valid leaf from a trusted proxy succeed; cases override.
    function certEnv(overrides = {}) {
        return {
            AUTH_MODE: "cert",
            AUTH_TRUSTED_PROXIES: "10.0.0.0/8",
            AUTH_TRUST_STORE: bundlePath,
            AUTH_USER_MAP: userMapPath,
            ...overrides,
        };
    }

    function runPhp(script, stdinObject, envVars) {
        const r = spawnSync("php", [path.join(serverDir, script)], {
            cwd: serverDir,
            encoding: "utf8",
            input: JSON.stringify(stdinObject),
            env: { ...cleanEnv(), ...envVars },
        });
        if (r.status !== 0) {
            throw new Error(`php ${script} exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        }
        let parsed;
        try {
            parsed = JSON.parse(r.stdout);
        } catch (e) {
            throw new Error(`php ${script} printed non-JSON:\n${r.stdout}\nstderr: ${r.stderr}`);
        }
        return { out: parsed, stderr: r.stderr };
    }

    // Through getUserInfoCustom() in config.php.
    function userInfo(server, envVars) {
        return runPhp("harness.php", server, envVars);
    }

    // Straight into resolveCertIdentity(); returns the full result including reason and identifier.
    function resolve(server, envVars) {
        return runPhp("direct.php", { server, env: envVars }, {}).out;
    }

    function fromProxy(certName, extraServer = {}) {
        return { REMOTE_ADDR: "10.1.2.3", [HEADER_KEY]: headerEncode(certs[certName]), ...extraServer };
    }

    // --- Trusted proxy rule -------------------------------------------------------------

    test("(11) a certificate header with AUTH_TRUSTED_PROXIES empty is refused", () => {
        const r = resolve(fromProxy("alice"), certEnv({ AUTH_TRUSTED_PROXIES: "" }));
        expect(r.result.user_id).toBe(0);
        expect(r.result.user_groups).toEqual([]);
        expect(r.result.reason).toBe("untrusted_proxy");
        const viaConfig = userInfo(fromProxy("alice"), certEnv({ AUTH_TRUSTED_PROXIES: "" })).out;
        expect(viaConfig).toEqual({ user_id: 0, user_groups: [] });
    });

    test("(12) a certificate header from an address outside the trusted proxies is refused", () => {
        const r = resolve(fromProxy("alice", { REMOTE_ADDR: "192.0.2.1" }), certEnv());
        expect(r.result.user_id).toBe(0);
        expect(r.result.reason).toBe("untrusted_proxy");
    });

    // --- The default identities no longer apply -----------------------------------------

    test("(14) AUTH_MODE=cert ignores SITREC_DEFAULT_USERID when no certificate is presented", () => {
        const r = userInfo({ REMOTE_ADDR: "10.1.2.3" }, certEnv({ SITREC_DEFAULT_USERID: "1" }));
        expect(r.out).toEqual({ user_id: 0, user_groups: [] });
        expect(r.stderr).toMatch(/"reason":"no_certificate"/);
    });

    test("(15) AUTH_MODE=cert from loopback with no certificate is anonymous, no groups", () => {
        const r = userInfo({ REMOTE_ADDR: "127.0.0.1" }, certEnv({ AUTH_TRUSTED_PROXIES: "127.0.0.1" }));
        expect(r.out).toEqual({ user_id: 0, user_groups: [] });
        const direct = resolve({ REMOTE_ADDR: "127.0.0.1" }, certEnv({ AUTH_TRUSTED_PROXIES: "127.0.0.1" }));
        expect(direct.result.reason).toBe("no_certificate");
    });

    // --- Accepted certificates ------------------------------------------------------------

    test("(1) a valid leaf via the proxy header from a trusted proxy maps to its user", () => {
        const r = userInfo(fromProxy("alice"), certEnv());
        expect(r.out).toEqual({ user_id: 42, user_groups: [2, 14] });
        // The shared audit schema records the identity digest, never the identifier.
        expect(r.stderr).toMatch(/"auth":"cert"/);
        expect(r.stderr).toMatch(/"outcome":"accepted"/);
        const audit = JSON.parse(r.stderr.split('SITREC_AUDIT ')[1].split('\n')[0]);
        expect(audit).toMatchObject({schema: 'sitrec.audit.v1', event: 'authentication', actor_id: 42,
            effective_user_id: 42, outcome: 'accepted'});
        expect(audit.identifier_sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(audit.request_id).toMatch(/^[a-f0-9]{32}$/);
        expect(r.stderr).not.toMatch(/1234567890/);
        expect(r.stderr).not.toMatch(/SMITH/);
    });

    test("(1b) the default identifier sources: principal name first, then the Common Name suffix", () => {
        const viaSan = resolve(fromProxy("alice"), certEnv());
        expect(viaSan.result.identifier).toBe("alice.1234567890");
        expect(viaSan.result.user_id).toBe(42);

        const viaCn = resolve(fromProxy("alice"), certEnv({ AUTH_ID_SOURCE: "cn_suffix" }));
        expect(viaCn.result.identifier).toBe("1234567890");
        expect(viaCn.result.user_id).toBe(42);

        const wholeCn = resolve(fromProxy("alice"), certEnv({ AUTH_ID_SOURCE: "cn" }));
        expect(wholeCn.result.identifier).toBe("SMITH.ALEX.Q.1234567890");
        expect(wholeCn.result.reason).toBe("identifier_unmapped");
        expect(wholeCn.result.user_id).toBe(0);
    });

    test("(5) apache source: SSL_CLIENT_CERT with SSL_CLIENT_VERIFY=SUCCESS maps to its user", () => {
        const server = { REMOTE_ADDR: "192.0.2.1", SSL_CLIENT_CERT: certs.alice, SSL_CLIENT_VERIFY: "SUCCESS" };
        const env = certEnv({ AUTH_CERT_SOURCE: "apache", AUTH_TRUSTED_PROXIES: "" });
        expect(userInfo(server, env).out).toEqual({ user_id: 42, user_groups: [2, 14] });

        const unverified = resolve({ ...server, SSL_CLIENT_VERIFY: "NONE" }, env);
        expect(unverified.result.user_id).toBe(0);
        expect(unverified.result.reason).toBe("not_verified_by_server");
    });

    // --- Refused certificates -------------------------------------------------------------

    test("(6) a leaf from an untrusted issuer is refused", () => {
        const r = resolve(fromProxy("mallory"), certEnv());
        expect(r.result.user_id).toBe(0);
        expect(r.result.reason).toBe("chain_untrusted");
        expect(userInfo(fromProxy("mallory"), certEnv()).out).toEqual({ user_id: 0, user_groups: [] });
    });

    test("(7) a leaf without the client authentication extended key usage is refused", () => {
        const r = resolve(fromProxy("bob-signature"), certEnv());
        expect(r.result.user_id).toBe(0);
        expect(r.result.reason).toBe("eku_missing");
    });

    test("(dave) an expired leaf is refused", () => {
        if (!daveMinted) {
            console.warn("authCertMode: expired-certificate case skipped (see beforeAll)");
            return;
        }
        const r = resolve(fromProxy("dave-expired"), certEnv());
        expect(r.result.user_id).toBe(0);
        expect(r.result.reason).toBe("expired");
    });

    test("(8) certificate policy: a leaf carrying a listed policy passes, one without it is refused", () => {
        const env = certEnv({ AUTH_POLICY_OIDS: "1.3.6.1.4.1.99999.1.1" });
        expect(userInfo(fromProxy("carol-policy"), env).out).toEqual({ user_id: 43, user_groups: [2] });
        const alice = resolve(fromProxy("alice"), env);
        expect(alice.result.user_id).toBe(0);
        expect(alice.result.reason).toBe("policy_missing");
    });

    test("(9) with AUTH_USER_MAP unset every identifier is refused", () => {
        const r = resolve(fromProxy("alice"), certEnv({ AUTH_USER_MAP: "" }));
        expect(r.result.user_id).toBe(0);
        expect(r.result.reason).toBe("no_user_map");
        expect(userInfo(fromProxy("alice"), certEnv({ AUTH_USER_MAP: "" })).out).toEqual({ user_id: 0, user_groups: [] });
    });

    test("(9b) with AUTH_TRUST_STORE unset a valid leaf is refused", () => {
        const r = resolve(fromProxy("alice"), certEnv({ AUTH_TRUST_STORE: "" }));
        expect(r.result.user_id).toBe(0);
        expect(r.result.reason).toBe("no_trust_store");
    });

    test("(H) a header value that is not a certificate is refused with the parse reason", () => {
        const junk = { REMOTE_ADDR: "10.1.2.3", [HEADER_KEY]: headerEncode(
            "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n") };
        const r = resolve(junk, certEnv());
        expect(r.result.user_id).toBe(0);
        expect(r.result.reason).toBe("certificate_unparseable");

        const noBlock = resolve({ REMOTE_ADDR: "10.1.2.3", [HEADER_KEY]: "hello" }, certEnv());
        expect(noBlock.result.reason).toBe("no_certificate");
    });

    test("(H2) a header carrying more than one certificate block is refused, whichever comes first", () => {
        // A proxy that appends its header to one the client sent, or a client that sends a
        // chain, yields two blocks. Taking the first would let the sender pick the certificate.
        const twoValid = resolve({ REMOTE_ADDR: "10.1.2.3", [HEADER_KEY]: headerEncode(certs.alice + certs["carol-policy"]) }, certEnv());
        expect(twoValid.result.user_id).toBe(0);
        expect(twoValid.result.reason).toBe("multiple_certificates");

        const validThenJunk = resolve({ REMOTE_ADDR: "10.1.2.3", [HEADER_KEY]: headerEncode(
            certs.alice + "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n") }, certEnv());
        expect(validThenJunk.result.user_id).toBe(0);
        expect(validThenJunk.result.reason).toBe("multiple_certificates");
    });

    test("an identifier that fails AUTH_ID_PATTERN is refused before the map is consulted", () => {
        const r = resolve(fromProxy("alice"), certEnv({ AUTH_ID_PATTERN: "^[0-9]{10}$" }));
        expect(r.result.user_id).toBe(0);
        expect(r.result.reason).toBe("identifier_invalid");
        // The same pattern accepts the Common Name suffix.
        const ok = resolve(fromProxy("alice"), certEnv({ AUTH_ID_PATTERN: "^[0-9]{10}$", AUTH_ID_SOURCE: "cn_suffix" }));
        expect(ok.result.user_id).toBe(42);
    });

    // --- Other modes --------------------------------------------------------------------

    test("(10) AUTH_MODE=none is anonymous even from loopback with SITREC_DEFAULT_USERID set", () => {
        const r = userInfo({ REMOTE_ADDR: "127.0.0.1" }, { AUTH_MODE: "none", SITREC_DEFAULT_USERID: "1" });
        expect(r.out).toEqual({ user_id: 0, user_groups: [] });
    });

    test("(F) AUTH_MODE unset from loopback with no forum path keeps the loopback administrator", () => {
        const r = userInfo({ REMOTE_ADDR: "127.0.0.1" }, {});
        expect(r.out).toEqual({ user_id: 99999999, user_groups: [3, 2, 14, 9] });
        const forum = userInfo({ REMOTE_ADDR: "127.0.0.1" }, { AUTH_MODE: "forum" });
        expect(forum.out).toEqual({ user_id: 99999999, user_groups: [3, 2, 14, 9] });
        const remote = userInfo({ REMOTE_ADDR: "192.0.2.1" }, {});
        expect(remote.out).toEqual({ user_id: 0, user_groups: [] });
    });

    test("(F2) AUTH_MODE unset still honours SITREC_DEFAULT_USERID", () => {
        const r = userInfo({ REMOTE_ADDR: "192.0.2.1" }, { SITREC_DEFAULT_USERID: "7", SITREC_DEFAULT_USER_GROUPS: "2,9" });
        expect(r.out).toEqual({ user_id: 7, user_groups: [2, 9] });
    });

    test("an unrecognised AUTH_MODE is anonymous rather than falling through to a default identity", () => {
        const r = userInfo({ REMOTE_ADDR: "127.0.0.1" }, { AUTH_MODE: "certs", SITREC_DEFAULT_USERID: "1" });
        expect(r.out).toEqual({ user_id: 0, user_groups: [] });
        expect(r.stderr).toMatch(/AUTH_MODE/);
    });

    // --- The audit line -----------------------------------------------------------------

    test("authCertLogLine carries a hash prefix, never the identifier", () => {
        const r = resolve(fromProxy("alice"), certEnv());
        const log = JSON.parse(r.log);
        expect(log).toMatchObject({ auth: "cert", outcome: "accepted", reason: "ok", user_id: 42, remote_addr: "10.1.2.3" });
        expect(log.identifier_sha256).toMatch(/^[0-9a-f]{16}$/);
        expect(r.log).not.toContain("alice");
        expect(r.log).not.toContain("1234567890");

        const refused = resolve(fromProxy("alice", { REMOTE_ADDR: "192.0.2.1" }), certEnv());
        expect(JSON.parse(refused.log)).toMatchObject({ outcome: "refused", reason: "untrusted_proxy", user_id: 0, identifier_sha256: null });
    });

    // --- The trusted-proxy address matcher ----------------------------------------------

    test("authCertIpInList: IPv4 and IPv6, exact addresses and ranges", () => {
        const cases = [
            ["10.1.2.3", "10.0.0.0/8"],             // v4 range
            ["11.0.0.1", "10.0.0.0/8"],             // v4 outside range
            ["192.0.2.1", "192.0.2.1"],             // v4 exact
            ["192.0.2.2", "192.0.2.1"],             // v4 exact, different host
            ["192.0.2.130", "192.0.2.128/25"],      // v4 range not on a byte boundary
            ["192.0.2.127", "192.0.2.128/25"],      // just below it
            ["fd12:3456::1", "fd12:3456::/32"],     // v6 range
            ["fd12:3457::1", "fd12:3456::/32"],     // v6 outside range
            ["::1", "::1"],                         // v6 exact
            ["::2", "::1"],                         // v6 exact, different host
            ["10.1.2.3", "fd12::/16"],              // family mismatch
            ["10.1.2.3", ""],                       // empty list
            ["10.1.2.3", "not-an-address"],         // malformed entry
            ["10.1.2.3", "10.0.0.0/33"],            // prefix too long
            ["10.1.2.3", "192.0.2.0/24, 10.0.0.0/8"], // second entry matches
            ["not-an-address", "10.0.0.0/8"],       // malformed address
        ];
        const r = spawnSync("php", [path.join(serverDir, "cidr.php")], {
            cwd: serverDir, encoding: "utf8", input: JSON.stringify(cases), env: cleanEnv(),
        });
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual([
            true, false, true, false, true, false, true, false, true, false,
            false, false, false, false, true, false,
        ]);
    });
});
