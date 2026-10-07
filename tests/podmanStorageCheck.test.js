/**
 * Tests for the rootless Podman storage pre-check in install.sh and sitrec.sh.
 *
 * Two host settings make every image pull fail while Podman unpacks the layers:
 * an image store on a network file system ("processing tar file(lsetxattr /etc:
 * operation not supported)") and an account with no subordinate ID range
 * ("potentially insufficient UIDs or GIDs available in user namespace"). The
 * scripts warn about both before they pull.
 *
 * These run the REAL scripts through the bake path, with stub podman, uname and
 * stat commands first on PATH, so no container runtime is needed. The bake still
 * builds after a warning: the check only warns.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");

// These tests shell out to bash; skip on Windows where the scripts can't run.
const describeUnix = process.platform === "win32" ? describe.skip : describe;

const NETWORK_WARNING = "Podman keeps its images on a network file system";
const SUBID_WARNING = "no subordinate ID range";

// A temp dir holding the stub commands, an env file to bake, and a directory
// that stands in for Podman's image store (graphroot).
function mkFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sitrec-podman-"));
    const bin = path.join(dir, "bin");
    const graphroot = path.join(dir, "graph root");   // a space, as a home path may have
    fs.mkdirSync(bin);
    fs.mkdirSync(graphroot);

    const stubs = {
        // info: the fields check_podman_storage reads; everything else (build,
        // compose --help) succeeds silently.
        podman: '#!/bin/sh\nif [ "$1" = info ]; then printf "%s\\n" "$FAKE_PODMAN_INFO"; fi\nexit 0\n',
        docker: "#!/bin/sh\nexit 0\n",
        uname: '#!/bin/sh\necho "$FAKE_UNAME"\n',
        stat: '#!/bin/sh\necho "$FAKE_FSTYPE"\n',
    };
    for (const [name, body] of Object.entries(stubs)) {
        fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
    }

    const envFile = path.join(dir, "bake.env");
    fs.writeFileSync(envFile, "SITREC_EXAMPLE=1\n");
    return { dir, bin, graphroot, envFile };
}

function hostEnv(fx, { rootless = "true", uidmap = "1,65536,", gidmap = "1,65536,", fstype = "xfs", uname = "Linux" }) {
    return {
        ...process.env,
        PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
        FAKE_PODMAN_INFO: `${rootless} ${uidmap} ${gidmap} ${fx.graphroot}`,
        FAKE_FSTYPE: fstype,
        FAKE_UNAME: uname,
    };
}

function runInstallBake(host) {
    const fx = mkFixture();
    return execFileSync(
        "bash",
        [path.join(REPO, "install.sh"), "--podman", "--bake", "dummy:tag", "--env-file", fx.envFile],
        { cwd: fx.dir, encoding: "utf8", env: hostEnv(fx, host) }
    );
}

// sitrec.sh reads its compose command from .runtime beside itself, so run a copy.
function runSitrecBake(host, compose = "podman compose") {
    const fx = mkFixture();
    const script = path.join(fx.dir, "sitrec.sh");
    fs.copyFileSync(path.join(REPO, "sitrec.sh"), script);
    fs.writeFileSync(path.join(fx.dir, ".runtime"), compose);
    return execFileSync("bash", [script, "bake", "--env-file", fx.envFile, "dummy:tag"], {
        cwd: fx.dir,
        encoding: "utf8",
        env: hostEnv(fx, host),
    });
}

describeUnix("rootless Podman storage pre-check (install.sh / sitrec.sh)", () => {
    test("install.sh warns when the image store is on NFS, and still builds", () => {
        const out = runInstallBake({ fstype: "nfs" });
        expect(out).toContain(`${NETWORK_WARNING} (nfs)`);
        expect(out).toContain("graph root");
        expect(out).toContain("lsetxattr /etc: operation not supported");
        expect(out).not.toContain(SUBID_WARNING);
        expect(out).toContain("[sitrec] Built dummy:tag");
    });

    test("install.sh warns when the account has no subordinate ID range", () => {
        const out = runInstallBake({ uidmap: "1,", gidmap: "1," });
        expect(out).toContain(SUBID_WARNING);
        expect(out).toContain("podman system migrate");
        expect(out).not.toContain(NETWORK_WARNING);
    });

    test("install.sh is silent on a local disk with subordinate IDs", () => {
        const out = runInstallBake({});
        expect(out).not.toContain(NETWORK_WARNING);
        expect(out).not.toContain(SUBID_WARNING);
    });

    test("install.sh skips the check for rootful Podman and outside Linux", () => {
        for (const host of [{ rootless: "false", fstype: "nfs", uidmap: "1," }, { uname: "Darwin", fstype: "nfs", uidmap: "1," }]) {
            const out = runInstallBake(host);
            expect(out).not.toContain(NETWORK_WARNING);
            expect(out).not.toContain(SUBID_WARNING);
        }
    });

    test("sitrec.sh bake warns when the image store is on a CIFS share, and still builds", () => {
        const out = runSitrecBake({ fstype: "cifs" });
        expect(out).toContain(`${NETWORK_WARNING} (cifs)`);
        expect(out).toContain("[sitrec] Built dummy:tag");
    });

    test("sitrec.sh skips the check under Docker", () => {
        const out = runSitrecBake({ fstype: "nfs", uidmap: "1," }, "docker compose");
        expect(out).not.toContain(NETWORK_WARNING);
        expect(out).not.toContain(SUBID_WARNING);
    });
});
