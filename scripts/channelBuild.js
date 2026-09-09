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
            });
        });
    }
}
module.exports = {channelBuild, ChannelEntryPlugin};
