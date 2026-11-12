const crypto = require('crypto');
const {execFileSync} = require('child_process');

function channelBuild(version, env = process.env) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Build migration version must be numeric');
    const channel = env.SITREC_BUILD_CHANNEL || 'shipped';
    if (!['shipped', 'beta'].includes(channel)) throw new Error('Invalid build channel');
    const builtAt = env.SITREC_BUILD_TIME || new Date().toISOString();
    if (!Number.isFinite(Date.parse(builtAt))) throw new Error('Invalid build time');
    let revision = env.SITREC_SOURCE_HASH;
    if (!revision) {
        try { revision = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(); }
        catch { revision = 'local'; }
    }
    const id = env.SITREC_BUILD_ID || `${channel}-${builtAt.replace(/[^0-9]/g, '').slice(0, 17)}-${crypto.createHash('sha256').update(revision).digest('hex').slice(0, 12)}`;
    if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(id)) throw new Error('Invalid build ID');
    return {id, channel, version, builtAt: new Date(builtAt).toISOString()};
}

// The file of every chunk of a build, by chunk id, and the name of the global that its chunks
// register on. A page that still runs an OLDER build reads this file, never from a cache, when
// one of its own lazy chunks is no longer on the server: with it the page can load that chunk
// of the new build (src/StaleBuildRecovery.js). Each file name has a content hash, so the
// names here change with every build.
function chunkNames(compilation, build) {
    const chunks = {}, styles = {};
    for (const chunk of compilation.chunks) {
        if (chunk.id === null || chunk.id === undefined) continue;
        for (const file of chunk.files) {
            if (file.endsWith('.js')) chunks[chunk.id] = file;
            else if (file.endsWith('.css')) styles[chunk.id] = file;
        }
    }
    return {build, chunkLoadingGlobal: compilation.outputOptions.chunkLoadingGlobal, chunks, styles};
}

class ChannelEntryPlugin {
    constructor(build) { this.build = build; }
    apply(compiler) {
        compiler.hooks.thisCompilation.tap('ChannelEntry', compilation => {
            compilation.hooks.processAssets.tap({name: 'ChannelEntry',
                stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE}, () => {
                const files = compilation.entrypoints.get('index').getFiles();
                const entry = {build: this.build, scripts: files.filter(f => f.endsWith('.js')),
                    styles: files.filter(f => f.endsWith('.css'))};
                compilation.emitAsset('app-entry.json', new compiler.webpack.sources.RawSource(JSON.stringify(entry)));
                compilation.emitAsset('build-info.json', new compiler.webpack.sources.RawSource(JSON.stringify(this.build)));
                compilation.emitAsset('app-chunks.json', new compiler.webpack.sources.RawSource(JSON.stringify(chunkNames(compilation, this.build))));
            });
        });
    }
}
module.exports = {channelBuild, chunkNames, ChannelEntryPlugin};
