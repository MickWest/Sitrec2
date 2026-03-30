const path = require('path');
const fs = require('fs');
const InstallPaths = require('./config/config-install');

// In Docker development mode, sitrecServer is served by Apache via proxy
// So we don't need to copy it to the webpack output directory
const isDockerDev = process.env.NODE_ENV === 'development' && InstallPaths.dev_path === '/var/www/html';

const isServerlessBuild = process.env.IS_SERVERLESS_BUILD === 'true';

const patterns = [];

// Global ignore list applied to all copy patterns that use globs
const globalIgnore = ['**/.DS_Store'];

// Data directory handling
if (isServerlessBuild) {
    // For serverless: only copy essential data directories
    const serverlessDataDirs = ['custom', 'images', 'models', 'modelInspector', 'nightsky'];
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
    ignore: [...globalIgnore, "**/SitrecBridge/node_modules/**", "**/SitrecBridge/package-lock.json", "**/sitrec-comms/node_modules/**", "**/sitrec-comms/package-lock.json"],
} });
patterns.push({ from: "assets/install", to: "./install" });

// Copy tests directory (for browser-based benchmarks/tests) - dev only
// DOCKER_BUILD is set in Dockerfile for production builds
if (!process.env.DOCKER_BUILD && !isServerlessBuild) {
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
                ignore: [...globalIgnore, '**/config.php']
            }
        }
    );
    
    // Copy config.php from the config directory to ensure we get the real file
    // (not the empty placeholder that Docker creates due to overlapping volume mounts)
    // Falls back to the .example template for fresh worktrees / clones where
    // the gitignored config.php hasn't been created yet.
    const configPhpPath = fs.existsSync(path.resolve(__dirname, 'config/config.php'))
        ? './config/config.php'
        : './config/config.php.example';
    patterns.push(
        { from: configPhpPath, to: "./sitrecServer/config.php"}
    );
}

// copy the shared.env file, renaming it to shared.env.php to prevent direct access
// combined with the initial <?php tag, this will prevent the file from being served
// Falls back to .example template for fresh worktrees / clones.
if (!isServerlessBuild) {
    const sharedEnvPath = fs.existsSync(path.resolve(__dirname, 'config/shared.env'))
        ? './config/shared.env'
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
