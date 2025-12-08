const path = require('path');
const InstallPaths = require('./config/config-install');

// In Docker development mode, sitrecServer is served by Apache via proxy
// So we don't need to copy it to the webpack output directory
const isDockerDev = process.env.NODE_ENV === 'development' && InstallPaths.dev_path === '/var/www/html';

const isServerlessBuild = process.env.IS_SERVERLESS_BUILD === 'true';

const patterns = [];

// Data directory handling
if (isServerlessBuild) {
    // For serverless: only copy essential data directories
    const serverlessDataDirs = ['custom', 'images', 'models', 'modelInspector', 'nightsky'];
    serverlessDataDirs.forEach(dir => {
        patterns.push({ from: `data/${dir}`, to: `./data/${dir}` });
    });
} else {
    // For non-serverless: copy entire data directory
    patterns.push({ from: "data", to: "./data" });
}

// Web worker source code needs to be loaded at run time
// so we just copy it over
// This is currently not used
patterns.push({ from: "./src/workers/*.js", to:"" });
patterns.push({ from: "./src/PixelFilters.js", to:"./src" });

// Copy tools directory
patterns.push({ from: "tools", to: "./tools" });

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
                ignore: ['**/config.php']
            }
        }
    );
    
    // Copy config.php from the config directory to ensure we get the real file
    // (not the empty placeholder that Docker creates due to overlapping volume mounts)
    patterns.push(
        { from: "./config/config.php", to: "./sitrecServer/config.php"}
    );
}

// copy the shared.env file, renaming it to shared.env.php to prevent direct access
// combined with the initial <?php tag, this will prevent the file from being served
if (!isServerlessBuild) {
    patterns.push({
        from: "./config/shared.env", 
        to: "./shared.env.php",
        transform: (content, absoluteFrom) => {
            // Convert Buffer to string, prepend '<?php\n', then return as Buffer again
            const updatedContent = `<?php /*;\n${content.toString()}\n*/`;
            return Buffer.from(updatedContent);
        }
    });
}

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

module.exports = patterns;