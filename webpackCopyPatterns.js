const path = require('path');
const fs = require('fs');
const InstallPaths = require('./config/config-install');

// In Docker development mode, sitrecServer is served by Apache via proxy
// So we don't need to copy it to the webpack output directory
const isDockerDev = process.env.NODE_ENV === 'development' && InstallPaths.dev_path === '/var/www/html';

const isServerlessBuild = process.env.IS_SERVERLESS_BUILD === 'true';

// The secure build (webpack.secure.js) reuses the server patterns unchanged; the allow-list
// of server endpoints it ships is a later step, so nothing is conditioned on this yet.
const isSecureBuild = process.env.IS_SECURE_BUILD === 'true';

const patterns = [];

// Global ignore list applied to all copy patterns that use globs
const globalIgnore = ['**/.DS_Store'];

// Build timestamp used for cache-busting hand-authored standalone tools whose
// files have stable names (and are served with a long immutable cache header).
// Computed once per build invocation.
const BUILD_V = Date.now();

// Data directory handling
if (isServerlessBuild) {
    // For serverless: only copy essential data directories
    const serverlessDataDirs = ['custom', 'images', 'models', 'modelInspector', 'nightsky', 'egm96'];
    serverlessDataDirs.forEach(dir => {
        patterns.push({ from: `data/${dir}`, to: `./data/${dir}`, globOptions: { ignore: globalIgnore } });
    });
} else {
    // For non-serverless: copy entire data directory
    patterns.push({ from: "data", to: "./data", globOptions: { ignore: globalIgnore } });
}

// Web worker source code needs to be loaded at run time
// so we just copy it over
// This is currently not used
patterns.push({ from: "./src/workers/*.js", to:"" });
patterns.push({ from: "./src/PixelFilters.js", to:"./src" });

// Copy tools directory (exclude SitrecBridge dev artifacts — only the dist zip is needed)
patterns.push({ from: "tools", to: "./tools", globOptions: {
    ignore: [...globalIgnore, "**/SitrecBridge/node_modules/**", "**/SitrecBridge/package-lock.json",
        "**/SitrecBridge/dist/SitrecBridgeDev/**", "**/SitrecBridge/dist/SitrecBridgeDev.zip",
        "**/sitrec-comms/node_modules/**", "**/sitrec-comms/package-lock.json"],
} });

// Cache-busting for the standalone Starlink Flare tool: its index.html (which the
// browser revalidates) carries `?v=__BUILD_V__` on the stylesheet and the entry
// module; the module graph then reads that query off import.meta.url and appends
// it to every import / fetch / Worker URL. sw.js (the PWA service worker) carries
// the same stamp in its cache name, so a new build produces a byte-different worker
// that the browser installs and that purges the previous build's cache on activate.
// force:true so these overwrite the verbatim copies made by the "tools" pattern.
["index.html", "sw.js"].forEach((file) => {
    patterns.push({
        from: `tools/shf/${file}`,
        to: `./tools/shf/${file}`,
        force: true,
        transform(content) {
            return content.toString().replace(/__BUILD_V__/g, String(BUILD_V));
        },
    });
});

patterns.push({ from: "assets/install", to: "./install" });

// Copy tests directory (for browser-based benchmarks/tests) - dev only
// DOCKER_BUILD is set in Dockerfile for production builds
if (!process.env.DOCKER_BUILD && !isServerlessBuild && !isSecureBuild) {
    patterns.push({ from: "tests", to: "./tests", globOptions: { ignore: globalIgnore } });
}

// Only copy sitrecServer and config.php in non-serverless, non-Docker environments
// - Docker dev: Apache serves sitrecServer via proxy, so don't copy
// - Serverless: Zero PHP files in output
// - Local NGINX/prod: Copy sitrecServer for serving PHP
if (!isDockerDev && !isServerlessBuild) {
    // Copy sitrecServer directory, but exclude config.php (we'll copy it separately)
    // This prevents copying the empty placeholder file that Docker creates
    patterns.push(
        { 
            from: "sitrecServer", 
            to: "./sitrecServer",
            globOptions: {
                ignore: [...globalIgnore, '**/config.php', ...secureServerIgnores()]
            }
        }
    );

    // Copy config.php from the config directory to ensure we get the real file
    // (not the empty placeholder that Docker creates due to overlapping volume mounts)
    // Falls back to the .example template for fresh worktrees / clones where
    // the gitignored config.php hasn't been created yet.
    //
    // The secure build always packages the tracked example: it carries the identity seam
    // (the AUTH_MODE dispatch) the secure deployment relies on, and a checkout's own
    // config/config.php is that checkout's public-site configuration, not the artifact's.
    const liveConfigPhp = path.resolve(__dirname, 'config/config.php');
    let configPhpPath;
    if (isSecureBuild) {
        configPhpPath = './config/config.php.example';
        if (fs.existsSync(liveConfigPhp)) {
            console.warn('[secure build] config/config.php exists in this checkout but is not packaged; the secure artifact ships config/config.php.example');
        }
    } else {
        configPhpPath = fs.existsSync(liveConfigPhp) ? './config/config.php' : './config/config.php.example';
    }
    patterns.push(
        { from: configPhpPath, to: "./sitrecServer/config.php"}
    );
}

// The secure build ships only the server files named in scripts/secure-server-allowlist.json
// (the endpoints that fetch from public data providers, the assistant relays, the
// diagnostics pages and the telemetry writers are left out). Everything else under
// sitrecServer/ becomes an ignore pattern. Other builds ignore nothing here.
// scripts/auditBundleEgress.js checks the packaged tree against the same list.
function secureServerIgnores() {
    if (!isSecureBuild) return [];
    const allowlist = require('./scripts/secure-server-allowlist.json');
    const allowed = new Set(allowlist.files.map(entry => entry.file.replace(/\/$/, '')));
    const ignores = [];
    for (const name of fs.readdirSync(path.resolve(__dirname, 'sitrecServer'))) {
        if (name === 'config.php' || allowed.has(name)) continue;
        const isDir = fs.statSync(path.resolve(__dirname, 'sitrecServer', name)).isDirectory();
        ignores.push(isDir ? `**/sitrecServer/${name}/**` : `**/sitrecServer/${name}`);
    }
    return ignores;
}

// copy the shared.env file, renaming it to shared.env.php to prevent direct access
// combined with the initial <?php tag, this will prevent the file from being served
// Falls back to .example template for fresh worktrees / clones.
if (!isServerlessBuild) {
    // config/shared.env, or the file SITREC_SHARED_ENV names when building for another
    // deployment (see scripts/buildTarget.js).
    const targetEnvPath = require('./scripts/buildTarget').sharedEnvPath();
    const sharedEnvPath = fs.existsSync(targetEnvPath)
        ? targetEnvPath
        : './config/shared.env.example';
    patterns.push({
        from: sharedEnvPath,
        to: "./shared.env.php",
        transform: (content, absoluteFrom) => {
            // Convert Buffer to string, prepend '<?php\n', then return as Buffer again
            const updatedContent = `<?php /*;\n${content.toString()}\n*/`;
            return Buffer.from(updatedContent);
        }
    });
}

// Copy ThirdPartyNotices.txt (open-source license attributions)
patterns.push({ from: "ThirdPartyNotices.txt", to: "./", noErrorOnMissing: true });

// Copy favicon and manifest files
patterns.push(
    { from: "apple-touch-icon.png", to: "./" },
    { from: "favicon-512.png", to: "./" },
    { from: "favicon-32x32.png", to: "./" },
    { from: "favicon-16x16.png", to: "./" },
    // site.webmanifest names these two, and nothing else did — so every build published a
    // manifest pointing at icons it had not shipped. It went unnoticed while the manifest's
    // own <link href> was root-absolute, because on an install under a path (/sitrec/, or a
    // static host's subdirectory) the manifest itself 404'd first.
    { from: "android-chrome-192x192.png", to: "./" },
    { from: "android-chrome-512x512.png", to: "./" },
    { from: "site.webmanifest", to: "./" }
);

// Copy Draco decoder files for local hosting
patterns.push({
    from: path.join(__dirname, 'node_modules/three/examples/jsm/libs/draco/gltf'),
    to: './libs/draco'
});

// Copy OpenCV.js for local hosting
patterns.push({
    from: './src/js/opencv.js',
    to: './libs/opencv.js'
});

// Copy jsfeat for local hosting (optical flow tracking)
patterns.push({
    from: './src/js/jsfeat.js',
    to: './libs/jsfeat.js'
});

// Copy MediabunnyExporter for tools/flowgen.html
patterns.push({
    from: './src/MediabunnyExporter.js',
    to: './tools/src/MediabunnyExporter.js'
});

// Copy mediabunny bundle for tools
patterns.push({
    from: './node_modules/mediabunny/dist/bundles/mediabunny.min.mjs',
    to: './tools/libs/mediabunny.min.js'
});

// Copy OpenJPEG WASM decoder for JPEG 2000 support (JP2/J2K/NITF C8)
// Uses require.resolve for symlinked node_modules compatibility (see CLAUDE.md)
patterns.push({
    from: path.dirname(require.resolve('@cornerstonejs/codec-openjpeg/decodewasmjs')),
    to: './libs/openjpeg',
    globOptions: { ignore: [...globalIgnore, '**/openjpegjs.js', '**/openjpegwasm.js', '**/openjpegwasm.wasm'] },
});

module.exports = patterns;
