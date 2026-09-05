#!/usr/bin/env node
/**
 * Build a zero-dependency distributable zip of SitrecBridge.
 *
 * Bundles mcp-server.js + all npm dependencies into a single mcp-server.mjs,
 * copies the Chrome extension, Local Compute worker, and runtime files, then
 * creates SitrecBridge.zip.
 *
 * Usage:  node build-dist.mjs [--dev]
 * Output: dist/SitrecBridge.zip or dist/SitrecBridgeDev.zip
 */

import * as esbuild from "esbuild";
import {chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync} from "fs";
import {execFileSync} from "child_process";
import {buildExtension} from "./build-extension.mjs";
import {dirname, join} from "path";
import {fileURLToPath} from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dev = process.argv.includes("--dev");
const name = dev ? "SitrecBridgeDev" : "SitrecBridge";
const DIST = join(__dirname, "dist", name);

function isPythonCachePath(path) {
    return /(^|[/\\])__pycache__([/\\]|$)|\.pyc$/i.test(path);
}

// 1. Clean previous build
if (existsSync(DIST)) rmSync(DIST, {recursive: true});
mkdirSync(DIST, {recursive: true});

// 2. Bundle mcp-server.js with all dependencies
console.log("Bundling mcp-server.js ...");
const result = await esbuild.build({
    entryPoints: [join(__dirname, "mcp-server.js")],
    bundle: true,
    platform: "node",
    target: "node18",
    format: "esm",
    outfile: join(DIST, "mcp-server.mjs"),
    // CJS packages (ws, parts of MCP SDK) use require() internally. In ESM output,
    // require is undefined, so we inject a createRequire shim. esbuild places the
    // banner after the preserved shebang line.
    banner: {js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);"},
    // ws tries to require() these optional native addons; they fail gracefully at runtime
    external: ["bufferutil", "utf-8-validate"],
    logLevel: "info",
});

if (result.errors.length > 0) {
    console.error("Build failed:", result.errors);
    process.exit(1);
}

// 3. Copy runtime files the server reads via readFileSync(__dirname, ...)
cpSync(join(__dirname, "sitrec-mcp-guide.md"), join(DIST, "sitrec-mcp-guide.md"));
cpSync(join(__dirname, "README.md"), join(DIST, "README.md"));
cpSync(join(__dirname, "README-dev.md"), join(DIST, "README-dev.md"));
if (dev) {
    writeFileSync(join(DIST, "dev-mode.json"), "{\"development\":true}\n");
}
cpSync(join(__dirname, "local-compute"), join(DIST, "local-compute"), {
    recursive: true,
    filter: (src) => !isPythonCachePath(src),
});

// 3b. Copy launcher scripts (needed for Claude Desktop which doesn't inherit shell PATH)
cpSync(join(__dirname, "run.sh"), join(DIST, "run.sh"));
cpSync(join(__dirname, "run.bat"), join(DIST, "run.bat"));
chmodSync(join(DIST, "run.sh"), 0o755);

// 4. Copy the Chrome extension
buildExtension(join(__dirname, "extension"), join(DIST, "extension"), dev);

// 5. Create zip
const zipPath = join(__dirname, "dist", `${name}.zip`);
if (existsSync(zipPath)) rmSync(zipPath);
try {
    execFileSync("zip", ["-qr", `${name}.zip`, `${name}/`], {cwd: join(__dirname, "dist"), stdio: "inherit"});
    console.log(`\nDone: ${zipPath}`);
} catch (e) {
    console.error("\nzip command failed — the dist directory is still available at:");
    console.error(`  ${DIST}`);
    console.error("You can zip it manually or install the 'zip' command.");
    process.exit(1);
}
